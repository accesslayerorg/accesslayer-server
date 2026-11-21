// src/modules/indexer/co-creator-indexer.service.ts
//
// Indexes CoCreatorSet / CoCreatorRemoved contract events into the
// `key_cocreators` table (#1139).
//
// The contract emits:
// - CoCreatorSet    (topic `co_set`)    `{ creator_id, co_creator, split_bps }`
// - CoCreatorRemoved (topic `cc_rm`)    `{ creator_id, co_creator }`
//
// The worker may deliver either the PascalCase name, the SCREAMING_SNAKE
// alias, or the on-chain topic symbol; all spellings are accepted.
//
// Guarantees:
// - Idempotent and order-safe. Each roster row stores the (ledger,
//   eventIndex) of the last applied event and only a strictly newer event
//   mutates it, so replays, overlapping ingestion windows and out-of-order
//   delivery all converge on the latest on-chain state.
// - Nothing is silently dropped. A malformed event is moved to the indexer
//   DLQ.
// - Failures propagate, so the dispatcher does not advance the ledger
//   cursor past the batch and the batch is redelivered.
// - After every event, including stale/duplicate ones, the key's cached
//   co-creator responses are invalidated.

import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   processIndexerChainEvents,
   IndexerChainEvent,
} from '../../utils/indexer-event-processor.utils';
import { moveToDLQ } from '../../utils/indexer-dlq.utils';
import { invalidateCoCreatorCache } from '../co-creators/co-creators.service';

/** Event types that add or update a co-creator (CoCreatorSet). */
export const CO_CREATOR_ADDED_EVENT_TYPES: ReadonlySet<string> = new Set([
   'CO_CREATOR_ADDED',
   'CoCreatorAdded',
   'CO_CREATOR_SET',
   'CoCreatorSet',
   'co_set',
]);

/** Event types that remove a co-creator (CoCreatorRemoved). */
export const CO_CREATOR_REMOVED_EVENT_TYPES: ReadonlySet<string> = new Set([
   'CO_CREATOR_REMOVED',
   'CoCreatorRemoved',
   'cc_rm',
]);

export const ALL_CO_CREATOR_EVENT_TYPES: ReadonlySet<string> = new Set([
   ...CO_CREATOR_ADDED_EVENT_TYPES,
   ...CO_CREATOR_REMOVED_EVENT_TYPES,
]);

export const CO_CREATOR_INDEXER_DLQ_JOB_TYPE = 'CO_CREATOR';

/** Decoded co-creator event. */
export interface CoCreatorChainEvent extends IndexerChainEvent {
   creatorId: string;
   coCreator: string;
   /** Present on CoCreatorSet only. */
   splitBps?: number;
   role?: string;
}

export function isCoCreatorEvent(
   event: IndexerChainEvent
): event is CoCreatorChainEvent {
   return ALL_CO_CREATOR_EVENT_TYPES.has(event.eventType);
}

export interface ParsedCoCreatorEvent {
   keyId: string;
   wallet: string;
   added: boolean;
   splitBps: number | null;
   role: string;
   ledger: number;
   eventIndex: number;
   txHash: string;
}

export type CoCreatorParseResult =
   | { ok: true; value: ParsedCoCreatorEvent }
   | { ok: false; reason: string };

function readStringField(
   raw: Record<string, unknown>,
   ...names: string[]
): string | null {
   for (const name of names) {
      const value = raw[name];
      if (typeof value === 'string' && value.trim() !== '') {
         return value.trim();
      }
   }
   return null;
}

function parseUint32(value: unknown): number | null {
   if (value === undefined || value === null) return null;
   try {
      if (
         typeof value !== 'string' &&
         typeof value !== 'number' &&
         typeof value !== 'bigint'
      ) {
         return null;
      }
      const parsed = BigInt(value);
      if (parsed < 0n || parsed > 0xffffffffn) return null;
      return Number(parsed);
   } catch {
      return null;
   }
}

/** Pure validation of a raw event into a typed, persistable update. */
export function parseCoCreatorEvent(
   event: IndexerChainEvent
): CoCreatorParseResult {
   const raw = event as Record<string, unknown>;
   const added = CO_CREATOR_ADDED_EVENT_TYPES.has(event.eventType);

   const keyId = readStringField(
      raw,
      'creatorId',
      'creator_id',
      'keyId',
      'key_id',
      'creator'
   );
   if (!keyId) {
      return { ok: false, reason: 'missing or invalid key/creator id' };
   }

   const wallet = readStringField(
      raw,
      'coCreator',
      'co_creator',
      'co_creator_address',
      'wallet'
   );
   if (!wallet) {
      return { ok: false, reason: 'missing or invalid co-creator wallet' };
   }

   let splitBps: number | null = null;
   if (added) {
      splitBps = parseUint32(
         raw.splitBps ?? raw.split_bps ?? raw.shareBps ?? raw.share_bps
      );
      if (splitBps === null) {
         return { ok: false, reason: 'missing or invalid splitBps' };
      }
      if (splitBps > 10_000) {
         return { ok: false, reason: 'splitBps exceeds 10000' };
      }
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

   const role =
      readStringField(raw, 'role') ?? (added ? 'co_creator' : 'co_creator');

   return {
      ok: true,
      value: {
         keyId,
         wallet,
         added,
         splitBps,
         role,
         ledger,
         eventIndex,
         txHash: event.txHash,
      },
   };
}

/**
 * Applies the event to its roster row only if it is strictly newer than
 * the stored one. Returns true when the row changed.
 */
async function applyCoCreatorEvent(
   parsed: ParsedCoCreatorEvent
): Promise<boolean> {
   const rowKey = { keyId: parsed.keyId, wallet: parsed.wallet };
   const newerThanStored = {
      ...rowKey,
      OR: [
         { ledger: { lt: parsed.ledger } },
         { ledger: parsed.ledger, eventIndex: { lt: parsed.eventIndex } },
         { ledger: null },
      ],
   };
   const data = parsed.added
      ? {
           active: true,
           role: parsed.role,
           shareBps: parsed.splitBps,
           addedAt: new Date(),
           removedAt: null,
           ledger: parsed.ledger,
           eventIndex: parsed.eventIndex,
           txHash: parsed.txHash,
        }
      : {
           active: false,
           removedAt: new Date(),
           ledger: parsed.ledger,
           eventIndex: parsed.eventIndex,
           txHash: parsed.txHash,
        };

   const updated = await prisma.keyCoCreator.updateMany({
      where: newerThanStored,
      data,
   });
   if (updated.count > 0) return true;

   try {
      await prisma.keyCoCreator.create({
         data: { ...rowKey, ...data },
      });
      return true;
   } catch (error) {
      if ((error as { code?: string })?.code !== 'P2002') throw error;
   }

   // The row exists. Either the event is stale (nothing to do) or a
   // concurrent writer created it between our update and create; retry once.
   const retried = await prisma.keyCoCreator.updateMany({
      where: newerThanStored,
      data,
   });
   return retried.count > 0;
}

/**
 * Processes one co-creator event. Returns true when the roster row
 * changed, false for stale/duplicate or malformed (DLQ'd) events.
 * Database errors are rethrown; see the header comment.
 */
export async function processCoCreatorEvent(
   event: IndexerChainEvent
): Promise<boolean> {
   const eventId = `${event.txHash}:${event.eventIndex}`;
   const parsed = parseCoCreatorEvent(event);

   if (!parsed.ok) {
      logger.warn(
         { type: 'co_creator_event_rejected', eventId, reason: parsed.reason },
         'Malformed co-creator event moved to DLQ'
      );
      await moveToDLQ({
         jobType: CO_CREATOR_INDEXER_DLQ_JOB_TYPE,
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

   const value = parsed.value;
   const changed = await applyCoCreatorEvent(value);

   // Only after the write is durable, so a reader repopulating the cache
   // straight afterwards sees the new roster.
   await invalidateCoCreatorCache(value.keyId);

   logger.debug(
      {
         type: changed ? 'co_creator_indexed' : 'co_creator_stale_skipped',
         eventId,
         key_id: value.keyId,
         wallet: value.wallet,
         added: value.added,
         ledger: value.ledger,
      },
      changed
         ? 'Co-creator event indexed'
         : 'Stale co-creator event skipped'
   );
   return changed;
}

/**
 * Processes a batch of co-creator events in order; other events are
 * ignored. Cursor advancement belongs to the pipeline dispatcher.
 */
export async function processCoCreatorEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (!isCoCreatorEvent(event)) return;
      await processCoCreatorEvent(event);
   });
}
