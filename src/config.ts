import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

export const envSchema = z.object({
   PORT: z.coerce.number().default(3000),
   MODE: z.enum(['development', 'production', 'test']).default('development'),
   DATABASE_URL: z
      .string()
      .min(1, 'DATABASE_URL is required in the environment variables'),
   APP_SECRET: z
      .string()
      .min(32, 'APP_SECRET should be at least 32 characters')
      .default('accesslayer_default_development_secret_key_32_bytes_long'),

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
   ENABLE_RESPONSE_TIMING: z.coerce.boolean().default(true),
   API_VERSION: z.string().default('1.0.0'),
   ENABLE_API_VERSION_HEADER: z.coerce.boolean().default(true),
   ENABLE_SCHEMA_VERSION_HEADER: z.coerce.boolean().default(true),
   ENABLE_REQUEST_LOGGING: z.coerce.boolean().default(true),
   INDEXER_JITTER_FACTOR: z.coerce.number().min(0).max(1).default(0.1),
   BACKGROUND_JOB_LOCK_TTL_MS: z.coerce.number().int().positive().default(300000),
   CREATOR_LIST_SLOW_QUERY_THRESHOLD_MS: z.coerce.number().int().positive().default(500),
});

export const envConfig = envSchema.parse(process.env);

export const appConfig = {
   allowedOrigins: [
      'http://localhost:5173',
      'http://localhost:3000',
      envConfig.FRONTEND_URL,
   ].filter(Boolean),
};
