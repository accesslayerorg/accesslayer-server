import { maskSensitiveConfigValues } from './config-mask.utils';

/**
 * Structured summary of the loaded runtime configuration, emitted once at
 * startup. The summary is deliberately a curated subset of `envConfig` rather
 * than a full dump: it surfaces the environment context and the key feature
 * flags an operator needs to confirm how the process is configured, without
 * the noise of every tuning knob.
 *
 * Values are sourced through {@link maskSensitiveConfigValues}, so even though
 * only non-sensitive keys are selected here, any value that flows through is
 * already redacted. No secrets, passwords, keys, tokens, or connection-string
 * credentials are included.
 */
export interface StartupConfigSummary {
   environment: {
      mode: unknown;
      port: unknown;
      apiVersion: unknown;
      stellarNetwork: unknown;
      backendUrl: unknown;
      frontendUrl: unknown;
   };
   featureFlags: {
      responseTiming: unknown;
      apiVersionHeader: unknown;
      schemaVersionHeader: unknown;
      requestLogging: unknown;
      indexerDedupe: unknown;
      indexerDlq: unknown;
      indexerCursorStalenessWarning: unknown;
      ownershipSnapshotCleanup: unknown;
   };
}

/**
 * Build the structured startup configuration summary.
 *
 * @example
 * import { logger } from './utils/logger.utils';
 * import { buildStartupConfigSummary } from './utils/config-summary.utils';
 *
 * logger.info(buildStartupConfigSummary(), 'Loaded runtime configuration');
 */
export function buildStartupConfigSummary(): StartupConfigSummary {
   const config = maskSensitiveConfigValues();

   return {
      environment: {
         mode: config.MODE,
         port: config.PORT,
         apiVersion: config.API_VERSION,
         stellarNetwork: config.STELLAR_NETWORK,
         backendUrl: config.BACKEND_URL,
         frontendUrl: config.FRONTEND_URL,
      },
      featureFlags: {
         responseTiming: config.ENABLE_RESPONSE_TIMING,
         apiVersionHeader: config.ENABLE_API_VERSION_HEADER,
         schemaVersionHeader: config.ENABLE_SCHEMA_VERSION_HEADER,
         requestLogging: config.ENABLE_REQUEST_LOGGING,
         indexerDedupe: config.ENABLE_INDEXER_DEDUPE,
         indexerDlq: config.ENABLE_INDEXER_DLQ,
         indexerCursorStalenessWarning:
            config.ENABLE_INDEXER_CURSOR_STALENESS_WARNING,
         ownershipSnapshotCleanup: config.OWNERSHIP_SNAPSHOT_CLEANUP_ENABLED,
      },
   };
}
