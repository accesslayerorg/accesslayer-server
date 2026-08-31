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
const booleanCoerce = z.preprocess(val => {
   if (typeof val === 'string') {
      const lower = val.toLowerCase();
      if (lower === 'true' || lower === '1') return true;
      if (lower === 'false' || lower === '0') return false;
   }
   return val;
}, z.coerce.boolean());

const optionalNonEmptyString = z.preprocess(val => {
   if (typeof val === 'string' && val.trim().length === 0) {
      return undefined;
   }

   return val;
}, z.string().min(1).optional());

export const envSchema = z
   .object({
      PORT: z.coerce.number().default(3000),
      MODE: z
         .enum(['development', 'production', 'test'])
         .default('development'),
      DATABASE_URL: z
         .string()
         .min(1, 'DATABASE_URL is required in the environment variables'),
      NODE_ID: z.string().default('node-local'),

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
      PAYSTACK_PUBLIC_KEY: optionalNonEmptyString,
      ENABLE_RESPONSE_TIMING: booleanCoerce.default(true),
      API_VERSION: z.string().default('1.0.0'),
      ENABLE_API_VERSION_HEADER: booleanCoerce.default(true),
      ENABLE_SCHEMA_VERSION_HEADER: booleanCoerce.default(true),
      ENABLE_REQUEST_LOGGING: booleanCoerce.default(true),
      DB_QUERY_TIMEOUT_MS: z.coerce.number().default(5000),
      DB_POOL_WAIT_WARN_MS: z.coerce.number().int().positive().default(2000),
      DB_POOL_WAIT_ERROR_MS: z.coerce.number().int().positive().default(5000),
      WEBHOOK_MAX_PER_CREATOR: z.coerce.number().int().positive().default(5),
      WEBHOOK_RETRY_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),

      APP_SECRET: z
         .string()
         .min(32, 'APP_SECRET should be at least 32 characters')
         .default('accesslayer_default_development_secret_key_32_bytes_long'),

      // JWT auth
      JWT_SECRET: z
         .string()
         .min(32, 'JWT_SECRET should be at least 32 characters')
         .default('accesslayer_default_development_jwt_secret_key_32_bytes'),
      JWT_ISSUER: z.string().default('accesslayer-server'),
      JWT_EXPIRES_IN: z.string().default('15m'),
      JWT_ACCESS_TOKEN_TTL_SECONDS: z.coerce
         .number()
         .int()
         .positive()
         .default(900),

      // Redis cache
      REDIS_URL: z.string().default('redis://localhost:6379'),
      ENABLE_REDIS_CACHE: booleanCoerce.default(true),

      // Key trade lockup
      LOCKUP_DURATION_SECONDS: z.coerce.number().int().nonnegative().default(0),

      // Leaderboard volume
      LEADERBOARD_VOLUME_WINDOW_DAYS: z.coerce
         .number()
         .int()
         .positive()
         .default(7),
      LEADERBOARD_VOLUME_CACHE_TTL_SECONDS: z.coerce
         .number()
         .int()
         .positive()
         .default(300),

      INDEXER_JITTER_FACTOR: z.coerce.number().min(0).max(1).default(0.1),
      BACKGROUND_JOB_LOCK_TTL_MS: z.coerce
         .number()
         .int()
         .positive()
         .default(300000),
      SLOW_QUERY_THRESHOLD_MS: z.coerce.number().int().positive().default(500),
      CREATOR_LIST_SLOW_QUERY_THRESHOLD_MS: z.coerce
         .number()
         .int()
         .positive()
         .default(500),
      INDEXER_CURSOR_STALE_AGE_WARNING_MS: z.coerce
         .number()
         .int()
         .positive()
         .default(300000),
      INDEXER_HEARTBEAT_STALE_THRESHOLD_MS: z.coerce
         .number()
         .positive()
         .default(300000),

      // Indexer feature flags
      ENABLE_INDEXER_DEDUPE: booleanCoerce.default(true),
      ENABLE_INDEXER_DLQ: booleanCoerce.default(true),
      ENABLE_INDEXER_CURSOR_STALENESS_WARNING: booleanCoerce.default(true),

      // Stellar auth — optional server keypair secret used for SEP-10 challenge
      // signing. When absent the server falls back to an ephemeral random keypair.

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

   STELLAR_AUTH_SECRET: z.string().min(32).default('accesslayer_default_development_stellar_auth_secret_32b'),

       // Ownership snapshot cleanup job
      OWNERSHIP_SNAPSHOT_TABLE_NAME: z
         .string()
         .min(1)
         .default('creator_ownership_snapshots'),
      OWNERSHIP_SNAPSHOT_CLEANUP_DRY_RUN: z.coerce.boolean().default(true),
      OWNERSHIP_SNAPSHOT_RETENTION_DAYS: z.coerce
         .number()
         .int()
         .positive()
         .default(30),
      OWNERSHIP_SNAPSHOT_CLEANUP_ENABLED: z.coerce.boolean().default(false),
      OWNERSHIP_SNAPSHOT_CLEANUP_INTERVAL_MINUTES: z.coerce
         .number()
         .int()
         .positive()
         .default(60),

      // Price movement detection job (feeds price_moved notifications)
      DETECT_PRICE_MOVEMENTS_ENABLED: booleanCoerce.default(true),
      DETECT_PRICE_MOVEMENTS_INTERVAL_MINUTES: z.coerce
         .number()
         .int()
         .positive()
         .default(5),

      // Governance proposal sync job
      GOVERNANCE_SYNC_ENABLED: booleanCoerce.default(false),
      GOVERNANCE_SYNC_INTERVAL_MINUTES: z.coerce
         .number()
         .int()
         .positive()
         .default(5),

      // Request body size limits (see docs/body-size-limits.md).
      // Accepts any size string understood by the `bytes` package used
      // internally by body-parser (e.g. '100kb', '1mb', '10mb').
      BODY_SIZE_LIMIT_DEFAULT: z.string().min(1).default('10mb'),
      BODY_SIZE_LIMIT_AUTH: optionalNonEmptyString,
      BODY_SIZE_LIMIT_ADMIN: optionalNonEmptyString,
      BODY_SIZE_LIMIT_CREATORS: optionalNonEmptyString,

      // Distributed tracing
      // Shared secret trusted internal callers present in the
      // `x-internal-service-token` header to have their incoming
      // `X-Trace-Id` header honored instead of a freshly generated one.
      // Left unset by default, so no caller is trusted unless configured.
      TRACE_ID_TRUSTED_TOKEN: optionalNonEmptyString,
      INTERNAL_SERVICE_KEY: optionalNonEmptyString,

      // Query cost governor (#755): rolling per-wallet (or per-IP, when
      // unauthenticated) database query budget. See
      // src/middlewares/query-cost-governor.middleware.ts.
      QUERY_COST_BUDGET: z.coerce.number().int().positive().default(200),
      QUERY_COST_WINDOW_MS: z.coerce
         .number()
         .int()
         .positive()
         .default(60_000),
      // JSON object overriding/extending the default route->cost map in
      // src/constants/query-cost.constants.ts, e.g.
      // '{"GET /search": 8, "GET /custom-route": 2}'. Merged over the
      // defaults, not a full replacement, so operators only need to
      // specify what differs.
      QUERY_COST_MAP_JSON: optionalNonEmptyString,
      // Comma-separated wallet addresses that bypass the governor entirely.
      QUERY_COST_ADMIN_WALLETS: optionalNonEmptyString,
      HORIZON_WEBHOOK_SECRET: optionalNonEmptyString,
      WEBHOOK_RETRY_BASE_DELAY_MS: z.coerce
         .number()
         .int()
         .positive()
         .default(1000),
      SSE_HEARTBEAT_INTERVAL_MS: z.coerce
         .number()
         .int()
         .positive()
         .default(15000),
      SSE_QUEUE_CAPACITY: z.coerce.number().int().positive().default(1000),
      SSE_QUEUE_FULL_TIMEOUT_MS: z.coerce
         .number()
         .int()
         .positive()
         .default(5000),
      SSE_REPLAY_MAX_EVENTS: z.coerce.number().int().positive().default(100),


      // SSE subscription management (src/modules/subscriptions) — a wallet's
      // subscription set, persisted in Redis, distinct from the per-connection
      // heartbeat/queue/replay tuning above.
      SSE_MAX_CONNECTIONS_PER_WALLET: z.coerce
         .number()
         .int()
         .positive()

         .default(5),
      SSE_MAX_SUBSCRIPTIONS_PER_WALLET: z.coerce
         .number()
         .int()
         .positive()

         .default(10),
      SSE_SUBSCRIPTION_TTL_MS: z.coerce
         .number()
         .int()
         .positive()
         .default(300000),

      SSE_THROTTLE_DURATION_MS: z.coerce
         .number()
         .int()
         .positive()
         .default(1000),
   })
   .superRefine((data, ctx) => {
      if (data.MODE === 'production' && data.STELLAR_NETWORK === 'testnet') {
         ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['STELLAR_NETWORK'],
            message:
               'STELLAR_NETWORK should be "mainnet" when MODE is "production"',
         });
      }
   });
