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
    ENABLE_SCHEMA_VERSION_HEADER: true,
    ENABLE_REQUEST_LOGGING: true,
    DB_QUERY_TIMEOUT_MS: 5000,
    INDEXER_JITTER_FACTOR: 0.1,
    BACKGROUND_JOB_LOCK_TTL_MS: 300000,
    SLOW_QUERY_THRESHOLD_MS: 500,
    CREATOR_LIST_SLOW_QUERY_THRESHOLD_MS: 500,
    INDEXER_CURSOR_STALE_AGE_WARNING_MS: 300000,
    INDEXER_HEARTBEAT_STALE_THRESHOLD_MS: 300000,
    ENABLE_INDEXER_DEDUPE: true,
    ENABLE_INDEXER_DLQ: true,
    ENABLE_INDEXER_CURSOR_STALENESS_WARNING: true,
    OWNERSHIP_SNAPSHOT_TABLE_NAME: 'creator_ownership_snapshots',
    OWNERSHIP_SNAPSHOT_CLEANUP_DRY_RUN: true,
    OWNERSHIP_SNAPSHOT_RETENTION_DAYS: 30,
    OWNERSHIP_SNAPSHOT_CLEANUP_ENABLED: false,
    OWNERSHIP_SNAPSHOT_CLEANUP_INTERVAL_MINUTES: 60,
  },
}));

import { maskSensitiveConfigValues } from './config-mask.utils';

describe('maskSensitiveConfigValues', () => {
  it('redacts values for keys matching SECRET pattern', () => {
    const masked = maskSensitiveConfigValues();
    expect(masked.GOOGLE_CLIENT_SECRET).toBe('test***cret');
    expect(masked.CLOUDINARY_API_SECRET).toBe('test***cret');
    expect(masked.PAYSTACK_SECRET_KEY).toBe('sk_t***6789');
    expect(masked.APP_SECRET).toBe('acce***xxxx');
  });

  it('redacts values for keys matching KEY pattern', () => {
    const masked = maskSensitiveConfigValues();
    expect(masked.CLOUDINARY_API_KEY).toBe('test***-key');
    expect(masked.PAYSTACK_PUBLIC_KEY).toBe('pk_t***6789');
  });

  it('redacts values for keys matching PASSWORD pattern', () => {
    const masked = maskSensitiveConfigValues();
    expect(masked.GMAIL_APP_PASSWORD).toBe('my-a***word');
  });

  it('redacts the password portion of DATABASE_URL', () => {
    const masked = maskSensitiveConfigValues();
    expect(masked.DATABASE_URL).toBe(
      'postgresql://***:***@localhost:5432/testdb'
    );
  });

  it('passes through non-sensitive values as-is', () => {
    const masked = maskSensitiveConfigValues();
    expect(masked.PORT).toBe(3000);
    expect(masked.MODE).toBe('test');
    expect(masked.BACKEND_URL).toBe('http://localhost:3000');
    expect(masked.FRONTEND_URL).toBe('http://localhost:5173');
    expect(masked.STELLAR_NETWORK).toBe('testnet');
    expect(masked.API_VERSION).toBe('1.0.0');
  });

  it('preserves boolean values for non-sensitive keys', () => {
    const masked = maskSensitiveConfigValues();
    expect(masked.ENABLE_RESPONSE_TIMING).toBe(true);
    expect(masked.ENABLE_INDEXER_DEDUPE).toBe(true);
    expect(masked.OWNERSHIP_SNAPSHOT_CLEANUP_DRY_RUN).toBe(true);
  });

  it('preserves numeric values for non-sensitive keys', () => {
    const masked = maskSensitiveConfigValues();
    expect(masked.PORT).toBe(3000);
    expect(masked.DB_QUERY_TIMEOUT_MS).toBe(5000);
    expect(masked.SLOW_QUERY_THRESHOLD_MS).toBe(500);
  });
});
