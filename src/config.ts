import dotenv from 'dotenv';
import { envSchema } from './config.schema';

export { envSchema };

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

   // Body size limits
   MAX_BODY_SIZE_DEFAULT: z.string().default('1mb'),
   MAX_BODY_SIZE_ADMIN: z.string().default('10mb'),
   MAX_BODY_SIZE_CREATORS: z.string().default('5mb'),
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
