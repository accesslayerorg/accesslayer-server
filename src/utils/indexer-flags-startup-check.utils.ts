import { envConfig } from '../config';
import { logger } from './logger.utils';

export interface IndexerFlagsConfig {
   ENABLE_INDEXER_DEDUPE: boolean;
   ENABLE_INDEXER_DLQ: boolean;
   ENABLE_INDEXER_CURSOR_STALENESS_WARNING: boolean;
   INDEXER_JITTER_FACTOR: number;
   INDEXER_CURSOR_STALE_AGE_WARNING_MS: number;
}

/**
 * Thrown when one or more indexer feature flag invariants fail at startup.
 * The `issues` array carries one human-readable, actionable message per
 * problem so the operator can fix every issue in a single pass.
 */
export class IndexerFlagsConfigError extends Error {
   readonly issues: string[];

   constructor(issues: string[]) {
      super(
         `Invalid indexer feature flag configuration:\n  - ${issues.join('\n  - ')}`
      );
      this.name = 'IndexerFlagsConfigError';
      this.issues = issues;
   }
}

/**
 * Validates the cross-field invariants of the indexer feature flags. Each
 * env var is already type-checked by Zod in `src/config.ts`; this helper
 * additionally enforces relationships between flags and their thresholds.
 *
 * The function throws an `IndexerFlagsConfigError` with **all** detected
 * issues — operators see every problem at once instead of fixing them one
 * boot at a time.
 */
export function validateIndexerFeatureFlags(
   config: IndexerFlagsConfig
): void {
   const issues: string[] = [];

   if (
      !Number.isFinite(config.INDEXER_JITTER_FACTOR) ||
      config.INDEXER_JITTER_FACTOR < 0 ||
      config.INDEXER_JITTER_FACTOR > 1
   ) {
      issues.push(
         `INDEXER_JITTER_FACTOR must be a number between 0 and 1 (got ${config.INDEXER_JITTER_FACTOR})`
      );
   }

   if (
      !Number.isInteger(config.INDEXER_CURSOR_STALE_AGE_WARNING_MS) ||
      config.INDEXER_CURSOR_STALE_AGE_WARNING_MS <= 0
   ) {
      issues.push(
         `INDEXER_CURSOR_STALE_AGE_WARNING_MS must be a positive integer in milliseconds (got ${config.INDEXER_CURSOR_STALE_AGE_WARNING_MS})`
      );
   }

   if (
      config.ENABLE_INDEXER_CURSOR_STALENESS_WARNING &&
      config.INDEXER_CURSOR_STALE_AGE_WARNING_MS < 1000
   ) {
      issues.push(
         `ENABLE_INDEXER_CURSOR_STALENESS_WARNING is on, but INDEXER_CURSOR_STALE_AGE_WARNING_MS=${config.INDEXER_CURSOR_STALE_AGE_WARNING_MS} is below the 1000ms minimum — either disable the flag or raise the threshold`
      );
   }

   if (
      !config.ENABLE_INDEXER_DEDUPE &&
      config.ENABLE_INDEXER_DLQ
   ) {
      issues.push(
         'ENABLE_INDEXER_DLQ is on but ENABLE_INDEXER_DEDUPE is off — the DLQ relies on dedupe to identify duplicate failures, enable both or neither'
      );
   }

   if (issues.length > 0) {
      throw new IndexerFlagsConfigError(issues);
   }
}

/**
 * Wrapper for use in the bootstrapping flow. Reads the active env config,
 * validates it, and logs a one-line acknowledgement on success. Failures
 * are re-thrown so the caller can decide how to exit (e.g. process.exit(1)
 * with a stable, machine-readable code).
 */
export function runIndexerFeatureFlagsStartupCheck(): void {
   validateIndexerFeatureFlags({
      ENABLE_INDEXER_DEDUPE: envConfig.ENABLE_INDEXER_DEDUPE,
      ENABLE_INDEXER_DLQ: envConfig.ENABLE_INDEXER_DLQ,
      ENABLE_INDEXER_CURSOR_STALENESS_WARNING:
         envConfig.ENABLE_INDEXER_CURSOR_STALENESS_WARNING,
      INDEXER_JITTER_FACTOR: envConfig.INDEXER_JITTER_FACTOR,
      INDEXER_CURSOR_STALE_AGE_WARNING_MS:
         envConfig.INDEXER_CURSOR_STALE_AGE_WARNING_MS,
   });

   logger.info(
      {
         enableDedupe: envConfig.ENABLE_INDEXER_DEDUPE,
         enableDlq: envConfig.ENABLE_INDEXER_DLQ,
         enableStalenessWarning:
            envConfig.ENABLE_INDEXER_CURSOR_STALENESS_WARNING,
         cursorStaleAgeWarningMs:
            envConfig.INDEXER_CURSOR_STALE_AGE_WARNING_MS,
         jitterFactor: envConfig.INDEXER_JITTER_FACTOR,
      },
      'Indexer feature flags validated'
   );
}
