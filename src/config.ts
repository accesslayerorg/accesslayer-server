import { z } from 'zod';
import dotenv from 'dotenv';

// Load environment variables from .env file
// Note: Does not override existing environment variables
dotenv.config();

/**
 * Environment configuration schema with validation and defaults.
 * 
 * Configuration Source Precedence (highest to lowest):
 * 1. Environment Variables (.env file or system environment)
 * 2. Schema Defaults (defined below with .default())
 * 3. Validation Failure (startup fails if required field missing)
 * 
 * See docs/configuration.md for complete documentation.
 * See docs/CONFIG_SOURCE_PRECEDENCE.md for visual reference.
 */
export const envSchema = z.object({
   // Server Configuration
   PORT: z.coerce.number().default(3000),
   MODE: z.enum(['development', 'production', 'test']).default('development'),
   
   // Database (Required)
   DATABASE_URL: z
      .string()
      .min(1, 'DATABASE_URL is required in the environment variables'),
   
   // Security (Optional with dev default - MUST override in production)
   APP_SECRET: z
      .string()
      .min(32, 'APP_SECRET should be at least 32 characters')
      .default('accesslayer_default_development_secret_key_32_bytes_long'),

   // Email Configuration (Required)
   GMAIL_USER: z.string(),
   GMAIL_APP_PASSWORD: z.string(),
   
   // Google OAuth (Required)
   GOOGLE_CLIENT_ID: z
      .string()
      .min(1, 'GOOGLE_CLIENT_ID is required for Google OAuth'),
   GOOGLE_CLIENT_SECRET: z
      .string()
      .min(1, 'GOOGLE_CLIENT_SECRET is required for Google OAuth'),

   // URLs (Required)
   BACKEND_URL: z.string().url(),
   FRONTEND_URL: z
      .string()
      .url('FRONTEND_URL must be a valid URL')
      .min(1, 'FRONTEND_URL is required'),

   // Cloudinary (Required)
   CLOUDINARY_CLOUD_NAME: z
      .string()
      .min(1, 'CLOUDINARY_CLOUD_NAME is required for image uploads'),
   CLOUDINARY_API_KEY: z
      .string()
      .min(1, 'CLOUDINARY_API_KEY is required for image uploads'),
   CLOUDINARY_API_SECRET: z
      .string()
      .min(1, 'CLOUDINARY_API_SECRET is required for image uploads'),

   // Payment Processing (Required)
   PAYSTACK_SECRET_KEY: z
      .string()
      .min(1, 'PAYSTACK_SECRET_KEY is required for payment processing'),
   PAYSTACK_PUBLIC_KEY: z
      .string()
      .min(1, 'PAYSTACK_PUBLIC_KEY is required for payment processing')
      .optional(),
   
   // API Configuration (Optional with defaults)
   ENABLE_RESPONSE_TIMING: z.coerce.boolean().default(true),
   API_VERSION: z.string().default('1.0.0'),
   ENABLE_API_VERSION_HEADER: z.coerce.boolean().default(true),
   ENABLE_SCHEMA_VERSION_HEADER: z.coerce.boolean().default(true),
   ENABLE_REQUEST_LOGGING: z.coerce.boolean().default(true),
   
   // Indexer Configuration (Optional with defaults)
   INDEXER_JITTER_FACTOR: z.coerce.number().min(0).max(1).default(0.1),
   BACKGROUND_JOB_LOCK_TTL_MS: z.coerce.number().int().positive().default(300000),
   CREATOR_LIST_SLOW_QUERY_THRESHOLD_MS: z.coerce.number().int().positive().default(500),
   INDEXER_CURSOR_STALE_AGE_WARNING_MS: z.coerce.number().int().positive().default(300000),
});

/**
 * Validated and typed environment configuration.
 * 
 * This object is immutable and available for import throughout the application.
 * Configuration values are resolved at startup and do not change at runtime.
 * 
 * @example
 * import { envConfig } from './config';
 * 
 * const port = envConfig.PORT;
 * const isProduction = envConfig.MODE === 'production';
 */
export const envConfig = envSchema.parse(process.env);

/**
 * Derived application configuration.
 * 
 * These values are computed from envConfig at startup.
 */
export const appConfig = {
   allowedOrigins: [
      'http://localhost:5173',
      'http://localhost:3000',
      envConfig.FRONTEND_URL,
   ].filter(Boolean),
};
