import { z } from 'zod';

/**
 * Centralized Zod schema for all environment variables.
 *
 * Extracted into its own module so tests can validate the schema
 * in isolation (via `.safeParse()`) without triggering the eager
 * `envSchema.parse(process.env)` side-effect in `config.ts`.
 */
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
      ENABLE_RESPONSE_TIMING: z.coerce.boolean().default(true),
      API_VERSION: z.string().default('1.0.0'),
      ENABLE_API_VERSION_HEADER: z.coerce.boolean().default(true),
      ENABLE_REQUEST_LOGGING: z.coerce.boolean().default(true),

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
