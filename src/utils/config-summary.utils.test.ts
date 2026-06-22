jest.mock('../config', () => ({
   envConfig: {
      PORT: 3000,
      MODE: 'test',
      DATABASE_URL: 'postgresql://user:supersecret@localhost:5432/testdb',
      GMAIL_USER: 'test@example.com',
      GMAIL_APP_PASSWORD: 'my-app-password',
      GOOGLE_CLIENT_ID: 'test-client-id',
      GOOGLE_CLIENT_SECRET: 'test-client-secret',
      BACKEND_URL: 'http://localhost:3000',
      FRONTEND_URL: 'http://localhost:5173',
      CLOUDINARY_CLOUD_NAME: 'test-cloud',
      CLOUDINARY_API_KEY: 'test-api-key',
      CLOUDINARY_API_SECRET: 'test-api-secret',
      PAYSTACK_SECRET_KEY: 'sk_test_123456789',
      PAYSTACK_PUBLIC_KEY: 'pk_test_123456789',
      APP_SECRET: 'accesslayer_test_secret_key_32_bytes_long_xxxx',
      STELLAR_NETWORK: 'testnet',
      STELLAR_HORIZON_URL: 'https://horizon-testnet.stellar.org',
      STELLAR_SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
      ENABLE_RESPONSE_TIMING: true,
      API_VERSION: '1.0.0',
      ENABLE_API_VERSION_HEADER: true,
      ENABLE_SCHEMA_VERSION_HEADER: false,
      ENABLE_REQUEST_LOGGING: true,
      DB_QUERY_TIMEOUT_MS: 5000,
      INDEXER_JITTER_FACTOR: 0.1,
      BACKGROUND_JOB_LOCK_TTL_MS: 300000,
      SLOW_QUERY_THRESHOLD_MS: 500,
      CREATOR_LIST_SLOW_QUERY_THRESHOLD_MS: 500,
      INDEXER_CURSOR_STALE_AGE_WARNING_MS: 300000,
      INDEXER_HEARTBEAT_STALE_THRESHOLD_MS: 300000,
      ENABLE_INDEXER_DEDUPE: true,
      ENABLE_INDEXER_DLQ: false,
      ENABLE_INDEXER_CURSOR_STALENESS_WARNING: true,
      OWNERSHIP_SNAPSHOT_TABLE_NAME: 'creator_ownership_snapshots',
      OWNERSHIP_SNAPSHOT_CLEANUP_DRY_RUN: true,
      OWNERSHIP_SNAPSHOT_RETENTION_DAYS: 30,
      OWNERSHIP_SNAPSHOT_CLEANUP_ENABLED: false,
      OWNERSHIP_SNAPSHOT_CLEANUP_INTERVAL_MINUTES: 60,
   },
}));

import { buildStartupConfigSummary } from './config-summary.utils';

describe('buildStartupConfigSummary', () => {
   it('reports the environment context', () => {
      const summary = buildStartupConfigSummary();
      expect(summary.environment).toEqual({
         mode: 'test',
         port: 3000,
         apiVersion: '1.0.0',
         stellarNetwork: 'testnet',
         backendUrl: 'http://localhost:3000',
         frontendUrl: 'http://localhost:5173',
      });
   });

   it('reports the key feature flags with their values', () => {
      const summary = buildStartupConfigSummary();
      expect(summary.featureFlags).toEqual({
         responseTiming: true,
         apiVersionHeader: true,
         schemaVersionHeader: false,
         requestLogging: true,
         indexerDedupe: true,
         indexerDlq: false,
         indexerCursorStalenessWarning: true,
         ownershipSnapshotCleanup: false,
      });
   });

   it('does not include any sensitive config values', () => {
      const summary = buildStartupConfigSummary();
      const serialized = JSON.stringify(summary);

      expect(serialized).not.toContain('supersecret');
      expect(serialized).not.toContain('my-app-password');
      expect(serialized).not.toContain('test-client-secret');
      expect(serialized).not.toContain('test-api-secret');
      expect(serialized).not.toContain('sk_test_123456789');
      expect(serialized).not.toContain('accesslayer_test_secret_key');
   });

   it('exposes only the environment and featureFlags groups', () => {
      const summary = buildStartupConfigSummary();
      expect(Object.keys(summary).sort()).toEqual([
         'environment',
         'featureFlags',
      ]);
   });
});
