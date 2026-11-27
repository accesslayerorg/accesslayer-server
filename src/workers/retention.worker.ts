import { envConfig } from '../config';
import { RETENTION_RULES, type RetentionRule } from '../config/retention';
import { logger } from '../utils/logger.utils';
import { prisma } from '../utils/prisma.utils';
import { recordRetentionRowsDeleted } from '../utils/retention-metrics.utils';
import { pruneExpiredConsumedNonces } from '../modules/nonce/nonce.service';

export const RETENTION_BATCH_SIZE = 1000;
export const RETENTION_BATCH_PAUSE_MS = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
const UTC_RUN_HOUR = 3;
const VALID_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

type RetentionDeps = {
   queryRawUnsafe: (query: string, ...values: unknown[]) => Promise<unknown>;
   executeRawUnsafe: (query: string, ...values: unknown[]) => Promise<number>;
   recordRun: (data: {
      tableName: string;
      rowsDeleted: number;
      dryRun: boolean;
      error?: string;
   }) => Promise<unknown>;
   rules: readonly RetentionRule[];
   now: () => Date;
   pause: (ms: number) => Promise<void>;
   batchSize: number;
   dryRun: boolean;
   pruneNonces: () => number;
};

export interface RetentionTableResult {
   tableName: string;
   rowsDeleted: number;
   rowsWouldDelete?: number;
   dryRun: boolean;
   error?: string;
}

function quoteIdentifier(identifier: string): string {
   if (!VALID_IDENTIFIER.test(identifier)) {
      throw new Error(`Invalid retention SQL identifier: ${identifier}`);
   }
   return `"${identifier}"`;
}

function getWhereParts(rule: RetentionRule, cutoff: Date) {
   const table = quoteIdentifier(rule.tableName);
   const timestampColumn = quoteIdentifier(rule.timestampColumn);
   const whereParts = [`${timestampColumn} < $1`];
   const values: unknown[] = [cutoff];

   if (rule.eligibleStatuses?.length) {
      if (!rule.statusColumn) {
         throw new Error(
            `Retention rule for ${rule.tableName} requires a status column`
         );
      }
      const statusColumn = quoteIdentifier(rule.statusColumn);
      const placeholders = rule.eligibleStatuses.map(status => {
         values.push(status);
         return `$${values.length}`;
      });
      whereParts.push(`${statusColumn}::text IN (${placeholders.join(', ')})`);
   }

   return { table, where: whereParts.join(' AND '), values };
}

function errorMessage(error: unknown): string {
   return error instanceof Error ? error.message : String(error);
}

const defaultPause = (ms: number): Promise<void> =>
   new Promise(resolve => setTimeout(resolve, ms));

function getDefaultDeps(overrides?: Partial<RetentionDeps>): RetentionDeps {
   return {
      queryRawUnsafe: (query, ...values) =>
         (prisma.$queryRawUnsafe as RetentionDeps['queryRawUnsafe'])(
            query,
            ...values
         ),
      executeRawUnsafe: (query, ...values) =>
         (prisma.$executeRawUnsafe as RetentionDeps['executeRawUnsafe'])(
            query,
            ...values
         ),
      recordRun: data =>
         (
            prisma as typeof prisma & {
               retentionRun: { create: RetentionDeps['recordRun'] };
            }
         ).retentionRun.create(data),
      rules: RETENTION_RULES,
      now: () => new Date(),
      pause: defaultPause,
      batchSize: RETENTION_BATCH_SIZE,
      dryRun: envConfig.RETENTION_DRY_RUN,
      pruneNonces: pruneExpiredConsumedNonces,
      ...overrides,
   };
}

/** Run one retention sweep. Failures are isolated per table. */
export async function runRetentionWorker(
   overrides?: Partial<RetentionDeps>
): Promise<RetentionTableResult[]> {
   const deps = getDefaultDeps(overrides);
   const results: RetentionTableResult[] = [];

   for (const rule of deps.rules) {
      const result: RetentionTableResult = {
         tableName: rule.tableName,
         rowsDeleted: 0,
         dryRun: deps.dryRun,
      };

      try {
         if (!Number.isFinite(rule.maxAgeDays) || rule.maxAgeDays <= 0) {
            throw new Error(
               `Invalid maxAgeDays for retention rule ${rule.tableName}`
            );
         }
         const cutoff = new Date(
            deps.now().getTime() - rule.maxAgeDays * DAY_MS
         );
         const { table, where, values } = getWhereParts(rule, cutoff);

         if (deps.dryRun) {
            const rows = (await deps.queryRawUnsafe(
               `SELECT COUNT(*)::int AS count FROM ${table} WHERE ${where}`,
               ...values
            )) as Array<{ count: number }>;
            result.rowsWouldDelete = Number(rows[0]?.count ?? 0);
         } else {
            const batchSize = Math.min(
               RETENTION_BATCH_SIZE,
               Math.max(1, deps.batchSize)
            );
            const limitPlaceholder = values.length + 1;
            const deleteSql =
               `DELETE FROM ${table} WHERE "id" IN (` +
               `SELECT "id" FROM ${table} WHERE ${where} ` +
               `LIMIT $${limitPlaceholder})`;

            for (;;) {
               const deleted = await deps.executeRawUnsafe(
                  deleteSql,
                  ...values,
                  batchSize
               );
               result.rowsDeleted += deleted;
               if (deleted < batchSize) break;
               await deps.pause(RETENTION_BATCH_PAUSE_MS);
            }
         }

         logger.info(
            {
               tableName: rule.tableName,
               maxAgeDays: rule.maxAgeDays,
               dryRun: deps.dryRun,
               rowsDeleted: result.rowsDeleted,
               rowsWouldDelete: result.rowsWouldDelete,
            },
            deps.dryRun
               ? 'Retention dry-run table completed'
               : 'Retention table completed'
         );
      } catch (error) {
         result.error = errorMessage(error);
         logger.error(
            { tableName: rule.tableName, err: error },
            'Retention failed for table; continuing with remaining tables'
         );
      }

      if (!deps.dryRun) {
         recordRetentionRowsDeleted(rule.tableName, result.rowsDeleted);
      }

      try {
         await deps.recordRun({
            tableName: rule.tableName,
            rowsDeleted: result.rowsDeleted,
            dryRun: deps.dryRun,
            error: result.error,
         });
      } catch (error) {
         logger.error(
            { tableName: rule.tableName, err: error },
            'Failed to record retention run'
         );
      }
      results.push(result);
   }

   try {
      const prunedNonceGuards = deps.pruneNonces();
      if (prunedNonceGuards > 0) {
         logger.info(
            { prunedNonceGuards },
            'Expired in-memory nonce guards pruned'
         );
      }
   } catch (error) {
      logger.warn({ err: error }, 'Failed to prune in-memory nonce guards');
   }

   return results;
}

/** Milliseconds until the next 03:00 UTC run. */
export function millisecondsUntilNextRetentionRun(now: Date): number {
   const nextRun = new Date(
      Date.UTC(
         now.getUTCFullYear(),
         now.getUTCMonth(),
         now.getUTCDate(),
         UTC_RUN_HOUR
      )
   );
   if (nextRun.getTime() <= now.getTime()) {
      nextRun.setUTCDate(nextRun.getUTCDate() + 1);
   }
   return nextRun.getTime() - now.getTime();
}

let retentionTimer: NodeJS.Timeout | null = null;
let running = false;

export function startRetentionWorker(): void {
   if (!envConfig.RETENTION_WORKER_ENABLED) {
      logger.info('Retention worker is disabled');
      return;
   }
   stopRetentionWorker();

   const scheduleNext = () => {
      retentionTimer = setTimeout(async () => {
         if (!running) {
            running = true;
            try {
               await runRetentionWorker();
            } catch (error) {
               logger.error({ err: error }, 'Retention worker run failed');
            } finally {
               running = false;
            }
         }
         scheduleNext();
      }, millisecondsUntilNextRetentionRun(new Date()));
      retentionTimer.unref?.();
   };

   scheduleNext();
   logger.info('Retention worker scheduled daily at 03:00 UTC');
}

export function stopRetentionWorker(): void {
   if (retentionTimer) {
      clearTimeout(retentionTimer);
      retentionTimer = null;
   }
}
