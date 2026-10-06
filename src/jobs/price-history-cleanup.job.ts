// src/jobs/price-history-cleanup.job.ts
// Prunes creator_price_history rows older than the retention window
// (default 30 days) so TWAP/range queries against the table stay fast (#893).

import { envConfig } from '../config';
import { logger } from '../utils/logger.utils';
import { prisma } from '../utils/prisma.utils';

export type PriceHistoryCleanupResult = {
   cutoffTimestamp: Date;
   deletedCount: number;
   retentionDays: number;
};

type PriceHistoryCleanupDeps = {
   deleteMany: typeof prisma.creatorPriceHistory.deleteMany;
   now: () => Date;
   /** Rows fetched per delete batch. Defaults to 5000; overridable for tests. */
   batchSize: number;
};

function getCutoffTimestamp(now: Date, retentionDays: number): Date {
   const cutoffMs = retentionDays * 24 * 60 * 60 * 1000;
   return new Date(now.getTime() - cutoffMs);
}

/**
 * Deletes every CreatorPriceHistory row recorded before the retention
 * cutoff (default: 30 days ago).
 *
 * Deletion is batched in fixed-size chunks rather than a single
 * `DELETE ... WHERE recordedAt < cutoff` so a large backlog doesn't hold a
 * long-running lock against a table that trades are writing to concurrently.
 */
export async function cleanupExpiredPriceHistory(
   deps?: Partial<PriceHistoryCleanupDeps>
): Promise<PriceHistoryCleanupResult> {
   const deleteMany =
      deps?.deleteMany ?? prisma.creatorPriceHistory.deleteMany.bind(prisma.creatorPriceHistory);
   const now = deps?.now ?? (() => new Date());

   const retentionDays = envConfig.PRICE_HISTORY_RETENTION_DAYS;
   const cutoffTimestamp = getCutoffTimestamp(now(), retentionDays);

   const BATCH_SIZE = deps?.batchSize ?? 5000;
   let deletedCount = 0;

   // Delete in batches until nothing older than the cutoff remains, so a
   // large backlog doesn't take one long-held lock on a hot table.
   for (;;) {
      const rowsToDelete = await prisma.creatorPriceHistory.findMany({
         where: { recordedAt: { lt: cutoffTimestamp } },
         select: { id: true },
         take: BATCH_SIZE,
      });

      if (rowsToDelete.length === 0) {
         break;
      }

      const { count } = await deleteMany({
         where: { id: { in: rowsToDelete.map((row: { id: string }) => row.id) } },
      });
      deletedCount += count;

      if (rowsToDelete.length < BATCH_SIZE) {
         break;
      }
   }

   logger.info(
      {
         cutoffTimestamp: cutoffTimestamp.toISOString(),
         retentionDays,
         deletedCount,
      },
      'Price history cleanup completed'
   );

   return { cutoffTimestamp, deletedCount, retentionDays };
}

let cleanupTimer: NodeJS.Timeout | null = null;

export function startPriceHistoryCleanupJob() {
   if (!envConfig.PRICE_HISTORY_CLEANUP_ENABLED) {
      logger.info('Price history cleanup job is disabled');
      return;
   }

   const intervalMs = envConfig.PRICE_HISTORY_CLEANUP_INTERVAL_MINUTES * 60 * 1000;

   const run = async () => {
      try {
         await cleanupExpiredPriceHistory();
      } catch (error) {
         logger.error(
            { err: error },
            'Price history cleanup failed with an unexpected error'
         );
      }
   };

   void run();
   cleanupTimer = setInterval(() => {
      void run();
   }, intervalMs);

   if (typeof cleanupTimer.unref === 'function') {
      cleanupTimer.unref();
   }

   logger.info(
      {
         intervalMinutes: envConfig.PRICE_HISTORY_CLEANUP_INTERVAL_MINUTES,
         retentionDays: envConfig.PRICE_HISTORY_RETENTION_DAYS,
      },
      'Price history cleanup job started'
   );
}

export function stopPriceHistoryCleanupJob() {
   if (!cleanupTimer) {
      return;
   }

   clearInterval(cleanupTimer);
   cleanupTimer = null;
   logger.info('Price history cleanup job stopped');
}
