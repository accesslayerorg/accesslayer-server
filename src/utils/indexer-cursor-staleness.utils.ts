import { envConfig } from '../config';
import { prisma } from './prisma.utils';
import { logger } from './logger.utils';
import { formatCursorForDebug } from './cursor-debug.utils';

/** Correlates a staleness warning with the indexer job that observed it. */
export interface IndexerCursorStalenessContext {
   /** Indexer job or worker surface (e.g. `indexer`, `ledger-indexer`). */
   job?: string;
   /** Opaque cursor value from the backing store, when available. */
   cursor?: string;
   /** Latest indexed ledger sequence, when available. */
   ledger?: number;
}

/**
 * Emits a structured warning when the indexer cursor has not been updated within the
 * configured stale-age threshold.
 *
 * Call this in the indexer health-check path or polling loop after reading the cursor
 * from its backing store.
 *
 * Default threshold: `INDEXER_CURSOR_STALE_AGE_WARNING_MS` env variable (300 000 ms / 5 min).
 * Override with the `thresholdMs` parameter for per-call control.
 *
 * No log is emitted when `ENABLE_INDEXER_CURSOR_STALENESS_WARNING` is false or when lag
 * is at or below the threshold.
 *
 * @param lastUpdatedAt - Timestamp of the cursor's most recent update
 * @param thresholdMs   - Optional override; defaults to env config value
 * @param context       - Optional fields to correlate the warning with an indexer job
 */
export function warnIfIndexerCursorStale(
   lastUpdatedAt: Date,
   thresholdMs: number = envConfig.INDEXER_CURSOR_STALE_AGE_WARNING_MS,
   context: IndexerCursorStalenessContext = {}
): void {
   if (!envConfig.ENABLE_INDEXER_CURSOR_STALENESS_WARNING) {
      return;
   }

   const lagMs = Date.now() - lastUpdatedAt.getTime();
   if (lagMs > thresholdMs) {
      logger.warn({
         msg: 'Indexer cursor lag exceeded threshold',
         job: context.job ?? 'indexer',
         lagMs,
         thresholdMs,
         lastUpdatedAt: lastUpdatedAt.toISOString(),
         ...(context.cursor !== undefined ? { cursor: context.cursor } : {}),
         ...(context.ledger !== undefined ? { ledger: context.ledger } : {}),
      });
   }
}

/**
 * Reads the latest indexed-ledger cursor from the database and emits a staleness
 * warning when its age exceeds the configured threshold.
 *
 * Intended for the indexer worker heartbeat path after a successful run.
 */
export async function checkIndexerCursorStalenessFromStore(
   context: IndexerCursorStalenessContext = {}
): Promise<void> {
   if (!envConfig.ENABLE_INDEXER_CURSOR_STALENESS_WARNING) {
      return;
   }

   const status = await prisma.indexedLedger.findFirst({
      orderBy: { updatedAt: 'desc' },
   });

   if (!status) {
      return;
   }

   logger.debug({
      msg: 'Checking indexer cursor staleness',
      job: context.job ?? 'indexer',
      cursor: formatCursorForDebug(status.cursor),
      ledger: status.ledger,
   });

   warnIfIndexerCursorStale(
      status.updatedAt,
      envConfig.INDEXER_CURSOR_STALE_AGE_WARNING_MS,
      {
         job: context.job ?? 'indexer',
         cursor: status.cursor,
         ledger: status.ledger,
      }
   );
}
