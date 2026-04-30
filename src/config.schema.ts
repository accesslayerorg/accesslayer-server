import { z } from 'zod';

/**
 * Centralized Zod schema for all environment variables.
 *
 * Configuration Source Precedence (highest to lowest):
 * 1. Environment Variables (.env file or system environment)
 * 2. Schema Defaults (defined below with .default())
 * 3. Validation Failure (startup fails if required field missing)
 *
 * Extracted into its own module so tests can validate the schema
 * in isolation (via `.safeParse()`) without triggering the eager
 * `envSchema.parse(process.env)` side-effect in `config.ts`.
 *
 * See docs/configuration.md for complete documentation.
 * See docs/CONFIG_SOURCE_PRECEDENCE.md for visual reference.
 */
/**
 * Helper to correctly coerce boolean strings from environment variables.
 * Zod's default z.coerce.boolean() returns true for any non-empty string,
 * including "false" and "0", which is usually not what we want for .env files.
 */
const booleanCoerce = z.preprocess((val) => {
   if (typeof val === 'string') {
      const lower = val.toLowerCase();
      if (lower === 'true' || lower === '1') return true;
      if (lower === 'false' || lower === '0') return false;
   }
   return val;
}, z.coerce.boolean());

export const envSchema = z
   .object({
      PORT: z.coerce.number().default(3000),
      MODE: z.enum(['development', 'production', 'test']).default(
         'development'
      ),
      DATABASE_URL: z
         .string()
         .min(1, 'DATABASE_URL is required in the environment variables'),

      GMAIL_USER: z.string(),
      GMAIL_APP_PASSWORD: z.string(),
      // Google OAuth
      GOOGLE_CLIENT_ID: z
         .string()
         .min(1, 'GOOGLE_CLIENT_ID is required for Google OAuth'),
      GOOGLE_CLIENT_SECRET: z
         .string()
         .min(1, 'GOOGLE_CLIENT_SECRET is required for Google OAuth'),

      // URLs
      BACKEND_URL: z.string().url(),
      FRONTEND_URL: z
         .string()
         .url('FRONTEND_URL must be a valid URL')
         .min(1, 'FRONTEND_URL is required'),

      // Cloudinary
      CLOUDINARY_CLOUD_NAME: z
         .string()
         .min(1, 'CLOUDINARY_CLOUD_NAME is required for image uploads'),
      CLOUDINARY_API_KEY: z
         .string()
         .min(1, 'CLOUDINARY_API_KEY is required for image uploads'),
      CLOUDINARY_API_SECRET: z
         .string()
         .min(1, 'CLOUDINARY_API_SECRET is required for image uploads'),

      PAYSTACK_SECRET_KEY: z
         .string()
         .min(1, 'PAYSTACK_SECRET_KEY is required for payment processing'),
      PAYSTACK_PUBLIC_KEY: z
         .string()
         .min(1, 'PAYSTACK_PUBLIC_KEY is required for payment processing')
         .optional(),
      ENABLE_RESPONSE_TIMING: booleanCoerce.default(true),
      API_VERSION: z.string().default('1.0.0'),
      ENABLE_API_VERSION_HEADER: booleanCoerce.default(true),
      ENABLE_SCHEMA_VERSION_HEADER: booleanCoerce.default(true),
      ENABLE_REQUEST_LOGGING: booleanCoerce.default(true),
      DB_QUERY_TIMEOUT_MS: z.coerce.number().default(5000),

      APP_SECRET: z
         .string()
         .min(32, 'APP_SECRET should be at least 32 characters')
         .default('accesslayer_default_development_secret_key_32_bytes_long'),

      INDEXER_JITTER_FACTOR: z.coerce.number().min(0).max(1).default(0.1),
      BACKGROUND_JOB_LOCK_TTL_MS: z.coerce.number().int().positive().default(300000),
      CREATOR_LIST_SLOW_QUERY_THRESHOLD_MS: z.coerce.number().int().positive().default(500),
      INDEXER_CURSOR_STALE_AGE_WARNING_MS: z.coerce.number().int().positive().default(300000),
      INDEXER_HEARTBEAT_STALE_THRESHOLD_MS: z.coerce.number().positive().default(300000),

      // Indexer feature flags
      ENABLE_INDEXER_DEDUPE: booleanCoerce.default(true),
      ENABLE_INDEXER_DLQ: booleanCoerce.default(true),
      ENABLE_INDEXER_CURSOR_STALENESS_WARNING: booleanCoerce.default(true),

      // Stellar network
      STELLAR_NETWORK: z
         .enum(['testnet', 'mainnet'], {
            message:
               'STELLAR_NETWORK must be "testnet" or "mainnet". Set STELLAR_NETWORK in your .env file.',
         })
         .default('testnet'),
      STELLAR_HORIZON_URL: z
         .string()
         .url(
            'STELLAR_HORIZON_URL must be a valid URL (e.g. https://horizon-testnet.stellar.org)'
         )
         .default('https://horizon-testnet.stellar.org'),
      STELLAR_SOROBAN_RPC_URL: z
         .string()
         .url(
            'STELLAR_SOROBAN_RPC_URL must be a valid URL (e.g. https://soroban-testnet.stellar.org)'
         )
         .default('https://soroban-testnet.stellar.org'),

      // Ownership snapshot cleanup job
      OWNERSHIP_SNAPSHOT_TABLE_NAME: z
         .string()
         .min(1)
         .default('creator_ownership_snapshots'),
      OWNERSHIP_SNAPSHOT_CLEANUP_DRY_RUN: z.coerce.boolean().default(true),
      OWNERSHIP_SNAPSHOT_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
      OWNERSHIP_SNAPSHOT_CLEANUP_ENABLED: z.coerce.boolean().default(false),
      OWNERSHIP_SNAPSHOT_CLEANUP_INTERVAL_MINUTES: z.coerce.number().int().positive().default(60),
   })
   .superRefine((data, ctx) => {
      if (
         data.MODE === 'production' &&
         data.STELLAR_NETWORK === 'testnet'
      ) {
         ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['STELLAR_NETWORK'],
            message:
               'STELLAR_NETWORK should be "mainnet" when MODE is "production"',
         });
      }
   });
