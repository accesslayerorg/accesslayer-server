// src/modules/indexer/key-snapshot-indexer.service.ts
//
// Indexes SnapshotTaken contract events into the `key_snapshots` table (#1112).
//
// Each SnapshotTaken event carries a key's daily metrics: price, volume,
// holder_count and market_cap. They are stored as one row per
// (creatorId, UTC day) and served by GET /keys/:key_id/snapshots.
//
// Guarantees:
// - Idempotent and order-independent. The write is an upsert on
//   (creatorId, snapshotDate) that only overwrites an existing row when the
//   incoming event is newer by (ledger, eventIndex). Replays, overlapping
//   ingestion windows and out-of-order delivery all converge on the same row.
// - Nothing is silently dropped. A well-formed event is always stored, even
//   when its key is not registered yet (no FK on creatorId). A malformed event
//   goes to the indexer DLQ so it is visible and replayable.
// - Failures propagate. Any database error rethrows so the pipeline
//   dispatcher does NOT advance the ledger cursor past the batch.
//
// After every event, the key's cached snapshot responses (all ranges) are
// invalidated, including when the upsert was a no-op, to cover a crash that
// happened between the write and the invalidation.

import { randomUUID } from 'crypto';
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   processIndexerChainEvents,
   IndexerChainEvent,
} from '../../utils/indexer-event-processor.utils';
import { moveToDLQ } from '../../utils/indexer-dlq.utils';
import { cacheInvalidate } from '../../utils/redis.utils';
import {
   KEY_SNAPSHOT_RANGES,
   keySnapshotCacheKey,
} from '../../constants/redis.constants';

/** Event discriminators. Both spellings are accepted, as for TWAPUpdated. */
export const SNAPSHOT_TAKEN_EVENT_TYPES: ReadonlySet<string> = new Set([
   'SNAPSHOT_TAKEN',
   'SnapshotTaken',
]);

export const KEY_SNAPSHOT_INDEXER_DLQ_JOB_TYPE = 'SNAPSHOT_TAKEN';

/**
 * Decoded SnapshotTaken event as delivered by the indexing worker. Metric
 * fields are accepted in camelCase or snake_case (the contract emits
 * snake_case). Monetary values are stroops as string/bigint/number.
 * The timestamp is an ISO string, epoch milliseconds, or epoch seconds.
 */
export interface SnapshotTakenEvent extends IndexerChainEvent {
   creatorId?: string;
   keyId?: string;
   key_id?: string;
   price?: string | number | bigint;
   volume?: string | number | bigint;
   holderCount?: number | string;
   holder_count?: number | string;
   marketCap?: string | number | bigint;
   market_cap?: string | number | bigint;
   timestamp?: string | number;
   takenAt?: string | number;
}

export function isSnapshotTakenEvent(
   event: IndexerChainEvent
): event is SnapshotTakenEvent {
   return SNAPSHOT_TAKEN_EVENT_TYPES.has(event.eventType);
}

export interface ParsedKeySnapshot {
   creatorId: string;
   /** Midnight UTC of the day the snapshot belongs to. */
   snapshotDate: Date;
   price: bigint;
   volume: bigint;
   holderCount: number;
   marketCap: bigint;
   takenAt: Date;
   ledger: number;
   txHash: string;
   eventIndex: number;
}

export type KeySnapshotParseResult =
   | { ok: true; value: ParsedKeySnapshot }
   | { ok: false; reason: string };

function parseTimestamp(value: unknown): Date | null {
   if (value === undefined || value === null || value === '') return null;
   let date: Date;
   if (typeof value === 'number' || typeof value === 'bigint') {
      const n = Number(value);
      // Values below 1e12 are epoch seconds (Soroban timestamps); above, ms.
      date = new Date(n < 1e12 ? n * 1000 : n);
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

function parseNonNegativeInt(value: unknown): number | null {
   if (value === undefined || value === null || value === '') return null;
   if (typeof value === 'bigint') {
      return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)
         ? Number(value)
         : null;
   }
   const n = Number(value);
   return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** Midnight UTC of the calendar day `date` falls on. */
export function toUtcDay(date: Date): Date {
   return new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
   );
}

/** Pure validation of a raw event into a typed, persistable snapshot. */
export function parseSnapshotTakenEvent(
   event: IndexerChainEvent
): KeySnapshotParseResult {
   const raw = event as Record<string, unknown>;

   const rawKey = raw.creatorId ?? raw.keyId ?? raw.key_id;
   if (typeof rawKey !== 'string' || rawKey.trim() === '') {
      return { ok: false, reason: 'missing or invalid creatorId' };
   }

   const price = parseNonNegativeBigInt(raw.price);
   if (price === null) {
      return { ok: false, reason: 'missing or invalid price' };
   }
   const volume = parseNonNegativeBigInt(raw.volume);
   if (volume === null) {
      return { ok: false, reason: 'missing or invalid volume' };
   }
   const holderCount = parseNonNegativeInt(raw.holderCount ?? raw.holder_count);
   if (holderCount === null) {
      return { ok: false, reason: 'missing or invalid holder_count' };
   }
   const marketCap = parseNonNegativeBigInt(raw.marketCap ?? raw.market_cap);
   if (marketCap === null) {
      return { ok: false, reason: 'missing or invalid market_cap' };
   }

   const takenAt = parseTimestamp(raw.takenAt ?? raw.timestamp);
   if (takenAt === null) {
      return { ok: false, reason: 'missing or invalid timestamp' };
   }

   const ledger = parseNonNegativeInt(raw.ledger);
   if (ledger === null) {
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
         creatorId: rawKey.trim(),
         snapshotDate: toUtcDay(takenAt),
         price,
         volume,
         holderCount,
         marketCap,
         takenAt,
         ledger,
         txHash: event.txHash,
         eventIndex,
      },
   };
}

/** Drop every cached snapshot response for a key (all ranges, literal DELs). */
export async function invalidateKeySnapshotCache(
   creatorId: string
): Promise<void> {
   await cacheInvalidate(
      ...KEY_SNAPSHOT_RANGES.map(range => keySnapshotCacheKey(creatorId, range))
   );
}

/**
 * Upserts one snapshot. Inserts a new day, or overwrites an existing day only
 * when this event is newer by (ledger, eventIndex). Returns the number of rows
 * written (0 when an equal or newer event for that day is already stored).
 */
export async function upsertKeySnapshot(
   snapshot: ParsedKeySnapshot
): Promise<number> {
   return prisma.$executeRaw`
      INSERT INTO "key_snapshots" (
         "id", "creatorId", "snapshotDate", "price", "volume", "holderCount",
         "marketCap", "takenAt", "ledger", "txHash", "eventIndex", "updatedAt"
      ) VALUES (
         ${randomUUID()}, ${snapshot.creatorId}, ${snapshot.snapshotDate}::date,
         ${snapshot.price}, ${snapshot.volume}, ${snapshot.holderCount},
         ${snapshot.marketCap}, ${snapshot.takenAt}, ${snapshot.ledger},
         ${snapshot.txHash}, ${snapshot.eventIndex}, NOW()
      )
      ON CONFLICT ("creatorId", "snapshotDate") DO UPDATE SET
         "price" = EXCLUDED."price",
         "volume" = EXCLUDED."volume",
         "holderCount" = EXCLUDED."holderCount",
         "marketCap" = EXCLUDED."marketCap",
         "takenAt" = EXCLUDED."takenAt",
         "ledger" = EXCLUDED."ledger",
         "txHash" = EXCLUDED."txHash",
         "eventIndex" = EXCLUDED."eventIndex",
         "updatedAt" = NOW()
      WHERE ("key_snapshots"."ledger", "key_snapshots"."eventIndex")
          < (EXCLUDED."ledger", EXCLUDED."eventIndex")
   `;
}

/**
 * Processes one SnapshotTaken event.
 *
 * Returns `true` when a row was inserted or updated, `false` when the event
 * was stale/duplicate or malformed (and sent to the DLQ).
 * Database errors are rethrown on purpose; see the header comment.
 */
export async function processSnapshotTakenEvent(
   event: IndexerChainEvent
): Promise<boolean> {
   const eventId = `${event.txHash}:${event.eventIndex}`;
   const parsed = parseSnapshotTakenEvent(event);

   if (!parsed.ok) {
      logger.warn(
         {
            type: 'key_snapshot_event_rejected',
            eventId,
            reason: parsed.reason,
         },
         'Malformed SnapshotTaken event moved to DLQ'
      );
      await moveToDLQ({
         jobType: KEY_SNAPSHOT_INDEXER_DLQ_JOB_TYPE,
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

   const snapshot = parsed.value;
   const written = await upsertKeySnapshot(snapshot);

   // Invalidate only after the row is durable so a reader that repopulates
   // the cache immediately afterwards sees the new snapshot.
   await invalidateKeySnapshotCache(snapshot.creatorId);

   if (written > 0) {
      logger.info(
         {
            type: 'key_snapshot_indexed',
            eventId,
            creator_id: snapshot.creatorId,
            snapshot_date: snapshot.snapshotDate.toISOString().slice(0, 10),
            ledger: snapshot.ledger,
         },
         'Key analytics snapshot indexed'
      );
   } else {
      logger.debug(
         {
            type: 'key_snapshot_event_stale_skipped',
            eventId,
            creator_id: snapshot.creatorId,
         },
         'SnapshotTaken event not newer than stored snapshot; skipping'
      );
   }
   return written > 0;
}

/**
 * Processes a batch of SnapshotTaken events. Other events are ignored.
 * Does not advance the ledger cursor; the pipeline dispatcher does that.
 */
export async function processSnapshotTakenEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (!isSnapshotTakenEvent(event)) {
         return;
      }
      await processSnapshotTakenEvent(event);
   });
}
