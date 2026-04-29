// src/config.test.ts
// Tests for configuration source precedence and validation behavior.

import { z } from 'zod';
import { envSchema } from './config.schema';

/**
 * Test configuration schema behavior without affecting actual config.
 * These tests validate the documented source precedence rules and Stellar-specific logic.
 */

const booleanCoerce = z.preprocess((val) => {
   if (typeof val === 'string') {
      const lower = val.toLowerCase();
      if (lower === 'true' || lower === '1') return true;
      if (lower === 'false' || lower === '0') return false;
   }
   return val;
}, z.coerce.boolean());

const BASE_ENV = {
   PORT: '3000',
   MODE: 'development',
   DATABASE_URL: 'postgresql://localhost:5432/test',
   GMAIL_USER: 'test@example.com',
   GMAIL_APP_PASSWORD: 'secret',
   GOOGLE_CLIENT_ID: 'google-id',
   GOOGLE_CLIENT_SECRET: 'google-secret',
   BACKEND_URL: 'http://localhost:3000',
   FRONTEND_URL: 'http://localhost:5173',
   CLOUDINARY_CLOUD_NAME: 'cloud',
   CLOUDINARY_API_KEY: 'api-key',
   CLOUDINARY_API_SECRET: 'api-secret',
   PAYSTACK_SECRET_KEY: 'pk-secret',
   APP_SECRET: 'accesslayer_default_development_secret_key_32_bytes_long',
};

describe('Config Validation and Source Precedence', () => {
   
   describe('Stellar & General Schema Validation', () => {
      it('Defaults are applied correctly', () => {
         const defaults = envSchema.parse(BASE_ENV);
         expect(defaults.STELLAR_NETWORK).toBe('testnet');
         expect(defaults.STELLAR_HORIZON_URL).toBe('https://horizon-testnet.stellar.org');
         expect(defaults.API_VERSION).toBe('1.0.0');
         expect(defaults.ENABLE_INDEXER_DEDUPE).toBe(true);
      });

      it('Valid explicit config is accepted', () => {
         const valid = envSchema.safeParse({
            ...BASE_ENV,
            STELLAR_NETWORK: 'mainnet',
            STELLAR_HORIZON_URL: 'https://horizon.stellar.org',
         });
         expect(valid.success).toBe(true);
      });

      it('Invalid STELLAR_NETWORK value is rejected', () => {
         const badNetwork = envSchema.safeParse({
            ...BASE_ENV,
            STELLAR_NETWORK: 'devnet',
         });
         expect(badNetwork.success).toBe(false);
      });

      it('production MODE with testnet STELLAR_NETWORK should fail', () => {
         const mismatch = envSchema.safeParse({
            ...BASE_ENV,
            MODE: 'production',
            STELLAR_NETWORK: 'testnet',
         });
         expect(mismatch.success).toBe(false);
         if (!mismatch.success) {
            const issue = mismatch.error.issues.find((i: z.ZodIssue) => 
               i.path.includes('STELLAR_NETWORK') && i.message.includes('mainnet')
            );
            expect(issue).toBeDefined();
         }
      });
   });

   describe('Source Precedence & Zod Behavior', () => {
      it('Environment variable takes precedence over default', () => {
         const schema = z.object({
            PORT: z.coerce.number().default(3000),
         });

         const result = schema.parse({ PORT: '4000' });
         expect(result.PORT).toBe(4000);
      });

      it('Default used when environment variable not provided', () => {
         const schema = z.object({
            PORT: z.coerce.number().default(3000),
         });

         const result = schema.parse({});
         expect(result.PORT).toBe(3000);
      });

      it('Type coercion for numbers', () => {
         const schema = z.object({
            PORT: z.coerce.number(),
         });

         const result = schema.parse({ PORT: '4000' });
         expect(result.PORT).toBe(4000);
         expect(typeof result.PORT).toBe('number');
      });

      it('Type coercion for booleans', () => {
         const schema = z.object({
            ENABLED: booleanCoerce,
         });

         expect(schema.parse({ ENABLED: 'true' }).ENABLED).toBe(true);
         expect(schema.parse({ ENABLED: 'false' }).ENABLED).toBe(false);
         expect(schema.parse({ ENABLED: '1' }).ENABLED).toBe(true);
         expect(schema.parse({ ENABLED: '0' }).ENABLED).toBe(false);
      });

      it('Number range validation', () => {
         const schema = z.object({
            JITTER: z.coerce.number().min(0).max(1).default(0.1),
         });

         expect(schema.parse({ JITTER: '0.5' }).JITTER).toBe(0.5);
         expect(schema.parse({}).JITTER).toBe(0.1);
         expect(schema.safeParse({ JITTER: '2' }).success).toBe(false);
         expect(schema.safeParse({ JITTER: '-1' }).success).toBe(false);
      });
   });
});
