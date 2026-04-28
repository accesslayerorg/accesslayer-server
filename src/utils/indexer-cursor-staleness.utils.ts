import { logger } from './logger.utils';
import { envConfig } from '../config';

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
 * @param lastUpdatedAt - Timestamp of the cursor's most recent update
 * @param thresholdMs   - Optional override; defaults to env config value
 */
export function warnIfIndexerCursorStale(
  lastUpdatedAt: Date,
  thresholdMs: number = envConfig.INDEXER_CURSOR_STALE_AGE_WARNING_MS
): void {
  const ageMs = Date.now() - lastUpdatedAt.getTime();
  if (ageMs > thresholdMs) {
    logger.warn({
      msg: 'Indexer cursor is stale',
      lastUpdatedAt: lastUpdatedAt.toISOString(),
      ageMs,
      thresholdMs,
    });
  }
}
