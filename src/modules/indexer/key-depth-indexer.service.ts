// src/modules/indexer/key-depth-indexer.service.ts
//
// Indexes DepthUpdated contract events into the `key_depth` table (#1152).
//
// A DepthUpdated event carries the new absolute volume for one price level
// (side + price) of a key's order book; volume 0 empties the level.
//
// Guarantees:
// - Idempotent and order-safe. Each level row stores the (ledger, eventIndex)
//   of the last applied event and only a strictly newer event overwrites it,
//   so replays, overlapping ingestion windows and out-of-order delivery all
//   converge on the latest state.
// - Nothing is silently dropped. A malformed event goes to the indexer DLQ.
// - Failures propagate, so the dispatcher does not advance the ledger cursor
//   past the batch and the batch is redelivered.
//
// After every event, including stale/duplicate ones, the key's cached depth
// responses are invalidated; that also covers a crash between the write and
// the invalidation.

import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   processIndexerChainEvents,
   IndexerChainEvent,
} from '../../utils/indexer-event-processor.utils';
import { moveToDLQ } from '../../utils/indexer-dlq.utils';
import { cacheInvalidate } from '../../utils/redis.utils';
import { keyDepthCachePattern } from '../../constants/redis.constants';

export const DEPTH_UPDATED_EVENT_TYPES: ReadonlySet<string> = new Set([
   'DEPTH_UPDATED',
   'DepthUpdated',
]);

export const KEY_DEPTH_INDEXER_DLQ_JOB_TYPE = 'DEPTH_UPDATED';

export type DepthSide = 'bid' | 'ask';
const DEPTH_SIDES: readonly string[] = ['bid', 'ask'];

/** Decoded DepthUpdated event. `price`/`volume` are in stroops. */
export interface DepthUpdatedEvent extends IndexerChainEvent {
   creatorId: string;
   side: string;
   price: string | number | bigint;
   volume: string | number | bigint;
}

export function isDepthUpdatedEvent(
   event: IndexerChainEvent
): event is DepthUpdatedEvent {
   return DEPTH_UPDATED_EVENT_TYPES.has(event.eventType);
}

export interface ParsedDepthUpdate {
   creatorId: string;
   side: DepthSide;
   price: bigint;
   volume: bigint;
   ledger: number;
   txHash: string;
   eventIndex: number;
}

export type DepthParseResult =
   | { ok: true; value: ParsedDepthUpdate }
   | { ok: false; reason: string };

function parseBigInt(value: unknown): bigint | null {
   try {
      if (typeof value === 'number' && !Number.isInteger(value)) return null;
      if (typeof value === 'string' && value.trim() === '') return null;
      if (
         typeof value !== 'string' &&
         typeof value !== 'number' &&
         typeof value !== 'bigint'
      ) {
         return null;
      }
      return BigInt(value);
   } catch {
      return null;
   }
}

/** Pure validation of a raw event into a typed, persistable update. */
export function parseDepthUpdatedEvent(
   event: IndexerChainEvent
): DepthParseResult {
   const raw = event as Record<string, unknown>;

   if (typeof raw.creatorId !== 'string' || raw.creatorId.trim() === '') {
      return { ok: false, reason: 'missing or invalid creatorId' };
   }
   if (typeof raw.side !== 'string' || !DEPTH_SIDES.includes(raw.side)) {
      return { ok: false, reason: 'invalid side (expected bid or ask)' };
   }
   const price = parseBigInt(raw.price);
   if (price === null || price <= 0n) {
      return { ok: false, reason: 'missing or invalid price' };
   }
   const volume = parseBigInt(raw.volume);
   if (volume === null || volume < 0n) {
      return { ok: false, reason: 'missing or invalid volume' };
   }
   const ledger = Number(raw.ledger);
   if (
      raw.ledger === undefined ||
      raw.ledger === null ||
      !Number.isInteger(ledger) ||
      ledger < 0
   ) {
      return { ok: false, reason: 'missing or invalid ledger' };
   }
   const eventIndex = Number(event.eventIndex);
   if (
      typeof event.txHash !== 'string' ||
      event.txHash === '' ||
      !Number.isInteger(eventIndex) ||
      eventIndex < 0
   ) {
      return { ok: false, reason: 'missing or invalid txHash/eventIndex' };
   }

   return {
      ok: true,
      value: {
         creatorId: raw.creatorId.trim(),
         side: raw.side as DepthSide,
         price,
         volume,
         ledger,
         txHash: event.txHash,
         eventIndex,
      },
   };
}

/** Drop every cached depth/spread response for a key. */
export async function invalidateKeyDepthCache(
   creatorId: string
): Promise<void> {
   await cacheInvalidate(keyDepthCachePattern(creatorId));
}

/**
 * Applies the update to its level only if it is strictly newer than the
 * stored one. Returns true when the level changed.
 */
async function applyDepthUpdate(update: ParsedDepthUpdate): Promise<boolean> {
   const level = {
      creatorId: update.creatorId,
      side: update.side,
      price: update.price,
   };
   const newerThanStored = {
      ...level,
      OR: [
         { ledger: { lt: update.ledger } },
         { ledger: update.ledger, eventIndex: { lt: update.eventIndex } },
      ],
   };
   const data = {
      volume: update.volume,
      ledger: update.ledger,
      eventIndex: update.eventIndex,
      txHash: update.txHash,
   };

   const updated = await prisma.keyDepth.updateMany({
      where: newerThanStored,
      data,
   });
   if (updated.count > 0) return true;

   try {
      await prisma.keyDepth.create({ data: { ...level, ...data } });
      return true;
   } catch (error) {
      if ((error as { code?: string })?.code !== 'P2002') throw error;
   }

   // The level exists. Either it is newer (stale event, nothing to do) or a
   // concurrent writer created it between our update and create; retry once.
   const retried = await prisma.keyDepth.updateMany({
      where: newerThanStored,
      data,
   });
   return retried.count > 0;
}

/**
 * Processes one DepthUpdated event. Returns `true` when a level changed,
 * `false` for stale/duplicate or malformed (DLQ'd) events. Database errors
 * are rethrown on purpose; see the header comment.
 */
export async function processDepthUpdatedEvent(
   event: IndexerChainEvent
): Promise<boolean> {
   const eventId = `${event.txHash}:${event.eventIndex}`;
   const parsed = parseDepthUpdatedEvent(event);

   if (!parsed.ok) {
      logger.warn(
         { type: 'depth_event_rejected', eventId, reason: parsed.reason },
         'Malformed DepthUpdated event moved to DLQ'
      );
      await moveToDLQ({
         jobType: KEY_DEPTH_INDEXER_DLQ_JOB_TYPE,
         payload: JSON.parse(
            JSON.stringify(event, (_k, v) =>
               typeof v === 'bigint' ? v.toString() : v
            )
         ),
         retryCount: 0,
         failureReason: parsed.reason,
      });
      return false;
   }

   const update = parsed.value;
   const changed = await applyDepthUpdate(update);

   // Only after the write is durable, so a reader repopulating the cache
   // straight afterwards sees the new level.
   await invalidateKeyDepthCache(update.creatorId);

   logger.debug(
      {
         type: changed ? 'key_depth_indexed' : 'key_depth_stale_skipped',
         eventId,
         creator_id: update.creatorId,
         side: update.side,
         ledger: update.ledger,
      },
      changed ? 'Depth level indexed' : 'Stale DepthUpdated event skipped'
   );
   return changed;
}

/**
 * Processes a batch of DepthUpdated events in order; other events are
 * ignored. Cursor advancement belongs to the pipeline dispatcher.
 */
export async function processDepthUpdatedEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (!isDepthUpdatedEvent(event)) return;
      await processDepthUpdatedEvent(event);
   });
}
