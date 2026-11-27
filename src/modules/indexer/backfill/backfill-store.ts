// src/modules/indexer/backfill/backfill-store.ts
// Prisma-backed persistence for the backfill runner (#1337).
//
// - Shard progress lives in `backfill_jobs`, one row per shard.
// - Event claims use `ingested_events`, unique on (txHash, eventIndex). A
//   violation of that constraint means another writer already owns the event.

import { Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '../../../utils/prisma.utils';
import type { BackfillPlan } from './backfill-plan';
import type { BackfillEvent } from './backfill-source';
import type { BackfillStore, ShardRecord, ShardStats, ShardStatus } from './backfill-runner';

const UNIQUE_VIOLATION = 'P2002';
const RECORD_NOT_FOUND = 'P2025';

function optionalString(value: unknown): string | undefined {
   if (value === undefined || value === null) return undefined;
   return String(value);
}

function optionalDate(value: unknown): Date | undefined {
   if (value === undefined || value === null) return undefined;
   const date = value instanceof Date ? value : new Date(String(value));
   return Number.isNaN(date.getTime()) ? undefined : date;
}

function isPrismaError(error: unknown, code: string): boolean {
   return (
      error instanceof Prisma.PrismaClientKnownRequestError && error.code === code
   );
}

export function createPrismaBackfillStore(db: any = defaultPrisma): BackfillStore {
   return {
      async ensureShards(plan: BackfillPlan) {
         await db.backfillJob.createMany({
            data: plan.ranges.map(range => ({
               runKey: plan.runKey,
               shardIndex: range.shardIndex,
               contractId: plan.contractId,
               fromLedger: range.fromLedger,
               toLedger: range.toLedger,
            })),
            skipDuplicates: true,
         });
      },

      async listShards(runKey: string): Promise<ShardRecord[]> {
         const rows = await db.backfillJob.findMany({
            where: { runKey },
            orderBy: { shardIndex: 'asc' },
         });
         return rows.map((row: any) => ({
            runKey: row.runKey,
            shardIndex: row.shardIndex,
            fromLedger: row.fromLedger,
            toLedger: row.toLedger,
            status: row.status as ShardStatus,
            attempts: row.attempts,
            eventsFetched: row.eventsFetched,
            eventsInserted: row.eventsInserted,
            eventsDuplicate: row.eventsDuplicate,
            lastError: row.lastError,
         }));
      },

      async markRunning(runKey: string, shardIndex: number) {
         await db.backfillJob.update({
            where: { runKey_shardIndex: { runKey, shardIndex } },
            data: {
               status: 'RUNNING',
               attempts: { increment: 1 },
               startedAt: new Date(),
               lastError: null,
            },
         });
      },

      async markCompleted(runKey: string, shardIndex: number, stats: ShardStats) {
         await db.backfillJob.update({
            where: { runKey_shardIndex: { runKey, shardIndex } },
            data: {
               status: 'COMPLETED',
               eventsFetched: stats.eventsFetched,
               eventsInserted: stats.eventsInserted,
               eventsDuplicate: stats.eventsDuplicate,
               completedAt: new Date(),
            },
         });
      },

      async markFailed(runKey: string, shardIndex: number, error: string, stats: ShardStats) {
         await db.backfillJob.update({
            where: { runKey_shardIndex: { runKey, shardIndex } },
            data: {
               status: 'FAILED',
               lastError: error.slice(0, 2000),
               eventsFetched: stats.eventsFetched,
               eventsInserted: stats.eventsInserted,
               eventsDuplicate: stats.eventsDuplicate,
            },
         });
      },

      async claimEvent(event: BackfillEvent): Promise<boolean> {
         try {
            await db.ingestedEvent.create({
               data: {
                  ledgerSequence: event.ledger,
                  // Historical events from the worker may not carry a hash.
                  ledgerHash: optionalString(event.ledgerHash) ?? '',
                  txHash: event.txHash,
                  eventIndex: event.eventIndex,
                  eventType: event.eventType,
                  actor: optionalString(event.actor),
                  creatorId: optionalString(event.creatorId),
                  amount: optionalString(event.amount),
                  priceStroops: optionalString(event.priceStroops ?? event.price),
                  tradeAt: optionalDate(event.tradeAt),
               },
            });
            return true;
         } catch (error) {
            if (isPrismaError(error, UNIQUE_VIOLATION)) return false;
            throw error;
         }
      },

      async releaseEvent(event: BackfillEvent) {
         try {
            await db.ingestedEvent.deleteMany({
               where: { txHash: event.txHash, eventIndex: event.eventIndex },
            });
         } catch (error) {
            if (!isPrismaError(error, RECORD_NOT_FOUND)) throw error;
         }
      },
   };
}

/** Counts confirmed ingested events in a ledger range, for run verification. */
export function countIngestedEventsInRange(
   db: any = defaultPrisma
): (fromLedger: number, toLedger: number) => Promise<number> {
   return (fromLedger, toLedger) =>
      db.ingestedEvent.count({
         where: {
            ledgerSequence: { gte: fromLedger, lte: toLedger },
            status: 'CONFIRMED',
         },
      });
}
