// src/modules/indexer/backfill/backfill-runner.ts
// Runs a backfill plan shard by shard, with bounded concurrency (#1337).
//
// Guarantees:
// - Resume: COMPLETED shards are skipped on a re-run of the same plan.
// - No duplicate rows: every event is claimed on (txHash, eventIndex) before
//   it is applied. Overlapping ranges and retried shards lose the claim race
//   and skip the event.
// - Failure containment: a failing event releases its claim and fails only its
//   shard. Other shards keep running and the failed one can be retried.
//
// Known limit: the claim and the apply are separate steps. A process killed
// between them leaves a claimed event that was never applied; a re-run will
// skip it. Closing that window needs the apply to run inside the claim's
// transaction, which the domain writers do not support yet.

import type { BackfillPlan, ShardRange } from './backfill-plan';
import type { BackfillEvent, BackfillEventSource } from './backfill-source';
import type { Throttle } from './backfill-throttle';

export type ShardStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';

export interface ShardRecord extends ShardRange {
   runKey: string;
   status: ShardStatus;
   attempts: number;
   eventsFetched: number;
   eventsInserted: number;
   eventsDuplicate: number;
   lastError: string | null;
}

export interface ShardStats {
   eventsFetched: number;
   eventsInserted: number;
   eventsDuplicate: number;
}

export interface BackfillStore {
   ensureShards(plan: BackfillPlan): Promise<void>;
   listShards(runKey: string): Promise<ShardRecord[]>;
   markRunning(runKey: string, shardIndex: number): Promise<void>;
   markCompleted(runKey: string, shardIndex: number, stats: ShardStats): Promise<void>;
   markFailed(runKey: string, shardIndex: number, error: string, stats: ShardStats): Promise<void>;
   /** Returns true when this caller now owns the event; false when it was already claimed. */
   claimEvent(event: BackfillEvent): Promise<boolean>;
   releaseEvent(event: BackfillEvent): Promise<void>;
}

export type BackfillLog = (message: string, fields: Record<string, unknown>) => void;

export interface RunBackfillOptions {
   source: BackfillEventSource;
   store: BackfillStore;
   /** Applies one claimed event to the read models. Must not advance the live cursor. */
   applyEvent: (event: BackfillEvent) => Promise<void>;
   concurrency: number;
   pageSize?: number;
   throttle?: Throttle;
   log?: BackfillLog;
}

export interface ShardFailure {
   shardIndex: number;
   error: string;
}

export interface BackfillRunSummary {
   runKey: string;
   shardsTotal: number;
   /** Shards that completed during this invocation. */
   shardsCompleted: number;
   /** Shards already COMPLETED by an earlier invocation, so not re-processed. */
   shardsSkipped: number;
   shardsFailed: number;
   eventsFetched: number;
   eventsInserted: number;
   eventsDuplicate: number;
   failures: ShardFailure[];
}

const noopLog: BackfillLog = () => undefined;

/** Runs `worker` over `items` with at most `concurrency` in flight. */
async function runWithConcurrency<T>(
   items: T[],
   concurrency: number,
   worker: (item: T) => Promise<void>
): Promise<void> {
   let next = 0;
   const lanes = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
         const item = items[next];
         next += 1;
         await worker(item);
      }
   });
   await Promise.all(lanes);
}

/** Returns true when the shard completed, false when it failed (recorded in `failures`). */
async function processShard(
   plan: BackfillPlan,
   range: ShardRange,
   options: RunBackfillOptions,
   failures: ShardFailure[]
): Promise<boolean> {
   const { store, source, applyEvent, throttle, log = noopLog } = options;
   const pageSize = options.pageSize ?? 200;
   const stats: ShardStats = { eventsFetched: 0, eventsInserted: 0, eventsDuplicate: 0 };

   await store.markRunning(plan.runKey, range.shardIndex);
   log('backfill shard started', { runKey: plan.runKey, ...range });

   try {
      let cursor: string | null = null;
      do {
         if (throttle) await throttle.take();
         const page = await source.fetchPage({
            contractId: plan.contractId,
            fromLedger: range.fromLedger,
            toLedger: range.toLedger,
            cursor,
            limit: pageSize,
         });

         for (const event of page.events) {
            stats.eventsFetched += 1;
            const claimed = await store.claimEvent(event);
            if (!claimed) {
               stats.eventsDuplicate += 1;
               continue;
            }
            try {
               await applyEvent(event);
            } catch (error) {
               await store.releaseEvent(event);
               throw error;
            }
            stats.eventsInserted += 1;
         }

         cursor = page.nextCursor;
      } while (cursor);

      await store.markCompleted(plan.runKey, range.shardIndex, stats);
      log('backfill shard completed', { runKey: plan.runKey, shardIndex: range.shardIndex, ...stats });
      return true;
   } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await store.markFailed(plan.runKey, range.shardIndex, message, stats);
      failures.push({ shardIndex: range.shardIndex, error: message });
      log('backfill shard failed', { runKey: plan.runKey, shardIndex: range.shardIndex, error: message });
      return false;
   }
}

/**
 * Executes the plan. Shards that are already COMPLETED are skipped. Failures are
 * recorded per shard and reported in the summary rather than thrown, so one bad
 * shard does not hide the progress of the others.
 */
export async function runBackfill(plan: BackfillPlan, options: RunBackfillOptions): Promise<BackfillRunSummary> {
   if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
      throw new Error('concurrency must be a positive integer');
   }

   await options.store.ensureShards(plan);
   const existing = new Map((await options.store.listShards(plan.runKey)).map(row => [row.shardIndex, row]));

   const summary: BackfillRunSummary = {
      runKey: plan.runKey,
      shardsTotal: plan.ranges.length,
      shardsCompleted: 0,
      shardsSkipped: 0,
      shardsFailed: 0,
      eventsFetched: 0,
      eventsInserted: 0,
      eventsDuplicate: 0,
      failures: [],
   };

   const pending: ShardRange[] = [];
   for (const range of plan.ranges) {
      if (existing.get(range.shardIndex)?.status === 'COMPLETED') {
         summary.shardsSkipped += 1;
         continue;
      }
      pending.push(range);
   }

   await runWithConcurrency(pending, options.concurrency, async range => {
      const completed = await processShard(plan, range, options, summary.failures);
      if (completed) summary.shardsCompleted += 1;
   });

   // Totals come from the store so they match what was persisted, including
   // progress from earlier attempts of the same run.
   for (const row of await options.store.listShards(plan.runKey)) {
      summary.eventsFetched += row.eventsFetched;
      summary.eventsInserted += row.eventsInserted;
      summary.eventsDuplicate += row.eventsDuplicate;
   }
   summary.shardsFailed = summary.failures.length;

   return summary;
}

export interface VerificationMismatch {
   shardIndex: number;
   reason: string;
}

export interface VerificationReport {
   runKey: string;
   shardsChecked: number;
   mismatches: VerificationMismatch[];
}

/**
 * Checks a finished run: every shard completed, every fetched event accounted
 * for (inserted or duplicate), and the inserted rows still present in the
 * ledger range. Balance checks against on-chain state are a separate step.
 */
export async function verifyBackfillRun(
   runKey: string,
   store: Pick<BackfillStore, 'listShards'>,
   countIngestedEvents: (fromLedger: number, toLedger: number) => Promise<number>
): Promise<VerificationReport> {
   const shards = await store.listShards(runKey);
   const mismatches: VerificationMismatch[] = [];

   for (const shard of shards) {
      if (shard.status !== 'COMPLETED') {
         mismatches.push({ shardIndex: shard.shardIndex, reason: `shard is ${shard.status}, not COMPLETED` });
         continue;
      }
      const accounted = shard.eventsInserted + shard.eventsDuplicate;
      if (accounted !== shard.eventsFetched) {
         mismatches.push({
            shardIndex: shard.shardIndex,
            reason: `fetched ${shard.eventsFetched} events but accounted for ${accounted}`,
         });
      }
      const present = await countIngestedEvents(shard.fromLedger, shard.toLedger);
      if (present < shard.eventsInserted) {
         mismatches.push({
            shardIndex: shard.shardIndex,
            reason: `${shard.eventsInserted} inserted events but only ${present} present in ledgers ${shard.fromLedger}-${shard.toLedger}`,
         });
      }
   }

   return { runKey, shardsChecked: shards.length, mismatches };
}
