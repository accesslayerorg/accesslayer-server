// src/config.schema.ts
import { z } from 'zod';

const booleanCoerce = z
   .union([z.boolean(), z.string()])
   .transform(val => {
      if (typeof val === 'boolean') return val;
      const normalized = val.trim().toLowerCase();
      if (normalized === 'true' || normalized === '1') return true;
      if (normalized === 'false' || normalized === '0') return false;
      throw new Error(`Invalid boolean value: ${val}`);
   });

const optionalNonEmptyString = z
   .string()
   .trim()
   .min(1)
   .optional()
   .or(z.literal(''));

const chainIdSchema = z.enum(['testnet', 'mainnet']);

export const envSchema = z
   .object({
      NODE_ENV: z
         .enum(['development', 'test', 'production'])
         .default('development'),
      PORT: z.coerce.number().int().positive().default(4000),
      MODE: z.enum(['development', 'production']).default('development'),

      DATABASE_URL: z.string().url(),
      REDIS_URL: z.string().url(),
      REDIS_TTL_SECONDS: z.coerce.number().int().positive().default(60),
      JWT_SECRET: z.string().min(32),
      STELLAR_NETWORK: chainIdSchema.default('testnet'),
      SOROBAN_RPC_URL: z.string().url(),
      SOROBAN_RPC_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
      HORIZON_URL: z.string().url(),
      HORIZON_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

      // CORS allowed origins (comma-separated)
      CORS_ALLOWED_ORIGINS: z
         .string()
         .optional()
         .default('http://localhost:3000,http://localhost:4000'),

      // Swagger
      SWAGGER_ENABLED: booleanCoerce.default(false),

      // Telegram bot (admin notifications)
      TELEGRAM_BOT_TOKEN: z.string().optional(),
      TELEGRAM_CHAT_ID: z.string().optional(),

      // Email (Resend)
      RESEND_API_KEY: z.string().optional(),
      EMAIL_FROM: z.string().email().optional(),
      ADMIN_EMAILS: z.string().optional(),

      // Google OAuth (server-side verification)
      GOOGLE_CLIENT_ID: z.string().optional(),
      GOOGLE_CLIENT_SECRET: z.string().optional(),
      GOOGLE_REDIRECT_URI: z.string().url().optional(),

      // Admin allowlist (comma or space separated list of wallet addresses)
      ADMIN_WALLETS: z.string().optional(),
      TREASURY_WALLETS: z.string().optional(),

      // Rate limiting
      RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
      RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(100),
      // Key trading endpoints have stricter defaults
      KEY_TRADE_RATE_LIMIT_MAX_REQUESTS: z.coerce
         .number()
         .int()
         .positive()
         .default(20),
      // Auth endpoints have stricter defaults
      AUTH_RATE_LIMIT_MAX_REQUESTS: z.coerce
         .number()
         .int()
         .positive()
         .default(10),

      // Indexer
      INDEXER_ENABLED: booleanCoerce.default(true),
      INDEXER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
      INDEXER_START_LEDGER: z.coerce.number().int().nonnegative().optional(),
      INDEXER_CONCURRENCY: z.coerce.number().int().positive().default(1),
      INDEXER_MAX_BATCH_SIZE: z.coerce.number().int().positive().default(50),
      INDEXER_RETRY_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
      INDEXER_RETRY_BACKOFF_MS: z.coerce.number().int().positive().default(1000),
      INDEXER_HEARTBEAT_INTERVAL_SECONDS: z.coerce
         .number()
         .int()
         .positive()
         .default(60),
      INDEXER_LAST_PROCESSED_KEY: z.string().default('indexer:last_processed'),
      INDEXER_EVENT_TOPIC: z.string().default('contract:event'),
      INDEXER_PROCESSED_EVENT_IDS: z.string().default('indexer:processed_ids'),
      INDEXER_EVENT_TTL_SECONDS: z.coerce.number().int().positive().default(86400),

      // Indexer backpressure / health
      INDEXER_BACKPRESSURE_QUEUE_HIGH_WATERMARK: z.coerce
         .number()
         .int()
         .positive()
         .default(1000),
      INDEXER_BACKPRESSURE_SLOWDOWN_DELAY_MS: z.coerce
         .number()
         .int()
         .positive()
         .default(500),
      INDEXER_HEALTH_ALERT_THRESHOLD_FAILURES: z.coerce
         .number()
         .int()
         .positive()
         .default(10),
      INDEXER_LOG_VERBOSE: booleanCoerce.default(false),

      // Feature flags
      FEATURE_DAILY_REWARDS_ENABLED: booleanCoerce.default(true),
      FEATURE_WALLET_SEARCH_ENABLED: booleanCoerce.default(true),

      // Reputation scoring
      REPUTATION_SCORING_ENABLED: booleanCoerce.default(true),
      REPUTATION_REFRESH_INTERVAL_HOURS: z.coerce
         .number()
         .int()
         .positive()
         .default(24),

      // Export/CSV
      EXPORT_MAX_ROWS: z.coerce.number().int().positive().default(10000),

      // Idempotency
      IDEMPOTENCY_ENABLED: booleanCoerce.default(true),
      IDEMPOTENCY_TTL_SECONDS: z.coerce.number().int().positive().default(300),
      IDEMPOTENCY_HEADER_NAME: z.string().default('Idempotency-Key'),
      IDEMPOTENCY_MAX_BODY_BYTES: z.coerce.number().int().positive().default(1048576),

      // Daily rewards cron
      DAILY_REWARDS_CRON_ENABLED: booleanCoerce.default(true),
      DAILY_REWARDS_CRON_SCHEDULE: z.string().default('0 0 * * *'),
      DAILY_REWARDS_JOB_MAX_RETRIES: z.coerce.number().int().positive().default(3),
      DAILY_REWARDS_JOB_RETRY_DELAY_MS: z.coerce
         .number()
         .int()
         .positive()
         .default(5000),

      // Referral tier tracking cron (#1034)
      REFERRAL_TIER_CRON_ENABLED: booleanCoerce.default(true),
      REFERRAL_TIER_EVALUATION_SCHEDULE: z.string().default('0 3 * * *'),
      REFERRAL_TIER_BATCH_SIZE: z.coerce.number().int().positive().default(200),
      REFERRAL_TIER_CONCURRENCY: z.coerce.number().int().positive().default(4),

      // Campaign evaluation and expiry cron (#campaign-cron)
      CAMPAIGN_CRON_ENABLED: booleanCoerce.default(true),
      CAMPAIGN_EVALUATION_INTERVAL_HOURS: z.coerce
         .number()
         .int()
         .positive()
         .default(24),
      CAMPAIGN_END_CHECK_INTERVAL_MINUTES: z.coerce
         .number()
         .int()
         .positive()
         .default(60),
      CAMPAIGN_QUALIFICATION_BATCH_SIZE: z.coerce
         .number()
         .int()
         .positive()
         .default(100),
      CAMPAIGN_QUALIFICATION_CONCURRENCY: z.coerce
         .number()
         .int()
         .positive()
         .default(5),

      // Key NFT badge minting trigger service (#1148). Minting is disabled
      // until both the contract id and the server minter secret are set.
      BADGE_CONTRACT_ID: optionalNonEmptyString,
      BADGE_MINTER_SECRET: optionalNonEmptyString,
      // Single-swap size (XLM) that earns the WHALE_HOLDER badge.
      BADGE_WHALE_THRESHOLD_XLM: z.coerce.number().positive().default(10000),
      // Continuous hold (days) that earns the DIAMOND_HANDS badge.
      BADGE_HOLD_MILESTONE_DAYS: z.coerce.number().int().positive().default(365),
      // Highest leaderboard rank (inclusive) that earns the TOP_TRADER badge.
      BADGE_TOP_TRADER_MAX_RANK: z.coerce.number().int().positive().default(10),
      // Max mint attempts before a transient failure is treated as terminal.
      BADGE_MINT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
      // Slow request threshold (#754): warn-level log for requests exceeding this duration
      SLOW_REQUEST_THRESHOLD_MS: z.coerce.number().int().positive().default(2000),

      // Contract addresses
      KEY_CONTRACT_ID: optionalNonEmptyString,
      FEE_DISTRIBUTOR_CONTRACT_ID: optionalNonEmptyString,
      TREASURY_CONTRACT_ID: optionalNonEmptyString,
      REVENUE_CONTRACT_ID: optionalNonEmptyString,
      REFERRAL_CONTRACT_ID: optionalNonEmptyString,

      // Native XLM SAC contract id on Soroban
      NATIVE_SAC_CONTRACT_ID: z
         .string()
         .trim()
         .min(1)
         .default('CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'),

      // Circuit breaker (#987): deployed contract id holding the per-key
      // max_bps configuration, and the TTL (seconds) for the cached contract
      // read. Defaults to a 5-minute refresh window.
      CIRCUIT_BREAKER_CONTRACT_ID: optionalNonEmptyString,
      GATE_CONFIG_CONTRACT_ID: optionalNonEmptyString,
      CIRCUIT_BREAKER_CONFIG_CACHE_TTL_SECONDS: z.coerce
         .number()
         .int()
         .positive()
         .default(300),

      // Key content gate config cache (#1150)
      GATE_CONFIG_CACHE_TTL_SECONDS: z.coerce
         .number()
         .int()
         .positive()
         .default(60),

      // Dynamic fee contract (#1055)
      DYNAMIC_FEE_CONTRACT_ID: optionalNonEmptyString,

      // Nonce registry contract (#1039): deployed contract id holding the
      // on-chain single-use nonce registry, and short TTL for cached nonces.
      NONCE_REGISTRY_CONTRACT_ID: optionalNonEmptyString,
      NONCE_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(30),

      // LP position registry contract
      LP_CONTRACT_ID: optionalNonEmptyString,

      // Invoice protocol adapters. Unconfigured reads/execution fail closed.
      ISSUER_REPUTATION_CONTRACT_ID: optionalNonEmptyString,
      INVOICE_TRANSFER_CONTRACT_ID: optionalNonEmptyString,
      INVOICE_MARKET_CONTRACT_ID: optionalNonEmptyString,
      INVOICE_MARKET_ABI: optionalNonEmptyString,
      INVOICE_FRAUD_CONTRACT_ID: optionalNonEmptyString,
      INVOICE_TIMELOCK_CONTRACT_ID: optionalNonEmptyString,

      // Portfolio health score contract (get_health_score). Unset fails the
      // /investors/:wallet/health-score read closed with 503.
      PORTFOLIO_HEALTH_CONTRACT_ID: optionalNonEmptyString,

      // Social metadata sync (Pinata gateway used to resolve avatar CIDs)
      PINATA_GATEWAY_URL: z
         .string()
         .url(
            'PINATA_GATEWAY_URL must be a valid URL (e.g. https://gateway.pinata.cloud/ipfs)'
         )
         .default('https://gateway.pinata.cloud/ipfs'),

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

      // Price history cleanup job (#893) — prunes creator_price_history rows
      // older than the retention window so TWAP/range queries stay fast.
      PRICE_HISTORY_RETENTION_DAYS: z.coerce
         .number()
         .int()
         .positive()
         .default(30),
      PRICE_HISTORY_CLEANUP_ENABLED: z.coerce.boolean().default(true),
      PRICE_HISTORY_CLEANUP_INTERVAL_MINUTES: z.coerce
         .number()
         .int()
         .positive()
         .default(60),
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

export type Env = z.infer<typeof envSchema>;
