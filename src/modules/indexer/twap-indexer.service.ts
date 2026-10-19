// src/modules/indexer/twap-indexer.service.ts
//
// Indexes TWAPUpdated contract events into the `twap_snapshots` table (#1082).
//
// Guarantees (the "no gaps" acceptance criterion):
// - One row per (txHash, eventIndex). Replays, overlapping ingestion windows
//   and crash-recovery re-delivery are idempotent: the unique key turns the
//   second insert into a no-op rather than a duplicate or an error.
// - Nothing is silently dropped. A well-formed event is always stored, even
//   when its key is not registered yet (no FK on creatorId). A malformed event
//   is written to the indexer DLQ so it is visible and replayable.
// - Failures propagate. Any database error rethrows so the pipeline
//   dispatcher (`processIndexerEvents`) does NOT advance the ledger cursor
//   past the batch, and the batch is redelivered.
// - Rows are append-only and the API reads the latest by `computedAt`, so
//   out-of-order delivery cannot roll a key back to an older value.
//
// After every event, including duplicates, the affected key's cached TWAP
// responses are invalidated. Doing it on duplicates too covers a crash that
// happened between the insert and the invalidation.
//
// Cursor advancement belongs to the dispatcher, not this service.

import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   processIndexerChainEvents,
   IndexerChainEvent,
} from '../../utils/indexer-event-processor.utils';
import { moveToDLQ } from '../../utils/indexer-dlq.utils';
import { cacheInvalidate } from '../../utils/redis.utils';
import {
   TWAP_WINDOWS,
   twapSnapshotCacheKey,
   type TwapWindow,
} from '../../constants/redis.constants';

/** Event discriminators. Both spellings are accepted, as for BundleExecuted. */
export const TWAP_UPDATED_EVENT_TYPES: ReadonlySet<string> = new Set([
   'TWAP_UPDATED',
   'TWAPUpdated',
]);

export const TWAP_INDEXER_DLQ_JOB_TYPE = 'TWAP_UPDATED';

/**
 * Decoded TWAPUpdated event as delivered by the external indexing worker.
 * `twapPrice` is in stroops and may arrive as a string/bigint/number.
 * `computedAt` is an ISO string, epoch milliseconds, or epoch seconds.
 */
export interface TwapUpdatedEvent extends IndexerChainEvent {
   creatorId: string;
   window: string;
   twapPrice: string | number | bigint;
   observationCount: number;
   computedAt: string | number;
}

export function isTwapUpdatedEvent(
   event: IndexerChainEvent
): event is TwapUpdatedEvent {
   return TWAP_UPDATED_EVENT_TYPES.has(event.eventType);
}

export interface ParsedTwapUpdate {
   creatorId: string;
   window: TwapWindow;
   twapPrice: bigint;
   observationCount: number;
   computedAt: Date;
   ledger: number;
   txHash: string;
   eventIndex: number;
}

export type TwapParseResult =
   | { ok: true; value: ParsedTwapUpdate }
   | { ok: false; reason: string };

function parseComputedAt(value: unknown): Date | null {
   if (value === undefined || value === null || value === '') return null;
   let date: Date;
   if (typeof value === 'number') {
      // Values below 1e12 are epoch seconds (Soroban timestamps); above, ms.
      date = new Date(value < 1e12 ? value * 1000 : value);
   } else if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
      const n = Number(value.trim());
      date = new Date(n < 1e12 ? n * 1000 : n);
   } else {
      date = new Date(String(value));
   }
   return Number.isNaN(date.getTime()) ? null : date;
}

function parseNonNegativeBigInt(value: unknown): bigint | null {
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
      const parsed = BigInt(value);
      return parsed >= 0n ? parsed : null;
   } catch {
      return null;
   }
}

/** Pure validation of a raw event into a typed, persistable update. */
export function parseTwapUpdatedEvent(
   event: IndexerChainEvent
): TwapParseResult {
   const raw = event as Record<string, unknown>;

   if (typeof raw.creatorId !== 'string' || raw.creatorId.trim() === '') {
      return { ok: false, reason: 'missing or invalid creatorId' };
   }
   const window = raw.window;
   if (
      typeof window !== 'string' ||
      !(TWAP_WINDOWS as readonly string[]).includes(window)
   ) {
      return {
         ok: false,
         reason: `invalid window (expected one of ${TWAP_WINDOWS.join(', ')})`,
      };
   }
   const twapPrice = parseNonNegativeBigInt(raw.twapPrice);
   if (twapPrice === null) {
      return { ok: false, reason: 'missing or invalid twapPrice' };
   }
   const observationCount = Number(raw.observationCount);
   if (
      raw.observationCount === undefined ||
      raw.observationCount === null ||
      raw.observationCount === '' ||
      !Number.isInteger(observationCount) ||
      observationCount < 0
   ) {
      return { ok: false, reason: 'missing or invalid observationCount' };
   }
   const computedAt = parseComputedAt(raw.computedAt);
   if (computedAt === null) {
      return { ok: false, reason: 'missing or invalid computedAt' };
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
         window: window as TwapWindow,
         twapPrice,
         observationCount,
         computedAt,
         ledger,
         txHash: event.txHash,
         eventIndex,
      },
   };
}

/**
 * Drop every cached TWAP response for a key (all windows). A single event
 * only names one window, but dependent pricing modules read all three, and
 * invalidating the whole key is three literal DELs (no SCAN), so it is
 * simpler and cheaper to be exhaustive than to be selective.
 */
export async function invalidateTwapSnapshotCache(
   creatorId: string
): Promise<void> {
   await cacheInvalidate(
      ...TWAP_WINDOWS.map(window => twapSnapshotCacheKey(creatorId, window))
   );
}

/**
 * Processes one TWAPUpdated event.
 *
 * Returns `true` when a new row was written, `false` when the event was a
 * duplicate or was rejected as malformed (and sent to the DLQ).
 * Database errors are rethrown on purpose; see the header comment.
 */
export async function processTwapUpdatedEvent(
   event: IndexerChainEvent
): Promise<boolean> {
   const eventId = `${event.txHash}:${event.eventIndex}`;
   const parsed = parseTwapUpdatedEvent(event);

   if (!parsed.ok) {
      logger.warn(
         { type: 'twap_event_rejected', eventId, reason: parsed.reason },
         'Malformed TWAPUpdated event moved to DLQ'
      );
      // If the DLQ write itself fails this throws, which blocks cursor
      // advancement; a rejected event must never vanish without a record.
      await moveToDLQ({
         jobType: TWAP_INDEXER_DLQ_JOB_TYPE,
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
   let inserted = true;

   try {
      await prisma.twapSnapshot.create({
         data: {
            creatorId: update.creatorId,
            window: update.window,
            twapPrice: update.twapPrice,
            observationCount: update.observationCount,
            computedAt: update.computedAt,
            ledger: update.ledger,
            txHash: update.txHash,
            eventIndex: update.eventIndex,
         },
      });
   } catch (error) {
      if ((error as { code?: string })?.code !== 'P2002') {
         throw error;
      }
      inserted = false;
      logger.debug(
         {
            type: 'twap_event_duplicate_skipped',
            eventId,
            creator_id: update.creatorId,
         },
         'TWAPUpdated event already indexed; skipping insert'
      );
   }

   // Invalidate only after the row is durable so a reader that repopulates
   // the cache immediately afterwards sees the new snapshot.
   await invalidateTwapSnapshotCache(update.creatorId);

   if (inserted) {
      logger.info(
         {
            type: 'twap_snapshot_indexed',
            eventId,
            creator_id: update.creatorId,
            window: update.window,
            observation_count: update.observationCount,
            ledger: update.ledger,
         },
         'TWAP snapshot indexed'
      );
   }
   return inserted;
}

/**
 * Processes a batch of TWAPUpdated events. Non-TWAP events are ignored.
 * Does not advance the ledger cursor; the pipeline dispatcher does that
 * once per batch, and only after this function resolves.
 */
export async function processTwapUpdatedEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (!isTwapUpdatedEvent(event)) {
         return;
      }
      await processTwapUpdatedEvent(event);
   });
}
