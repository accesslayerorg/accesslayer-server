/// <reference types="node" />
import { strict as assert } from 'assert';
import { envSchema } from './config.schema';
import { z } from 'zod';

/**
 * Minimal valid env fixture — satisfies every required field in envSchema
 * so individual tests can override only the values they care about.
 */
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
};

function run() {
   console.log('Running configuration validation tests...');

   // ── SECTION 1: Project Schema Validation (Stellar & General) ──

   // 1.1 Defaults are applied correctly
   const defaults = envSchema.parse(BASE_ENV);
   assert.equal(defaults.STELLAR_NETWORK, 'testnet');
   assert.equal(defaults.STELLAR_HORIZON_URL, 'https://horizon-testnet.stellar.org');
   assert.equal(defaults.API_VERSION, '1.0.0');
   assert.equal(defaults.ENABLE_INDEXER_DEDUPE, true);

   // 1.2 Valid explicit config is accepted
   const valid = envSchema.safeParse({
      ...BASE_ENV,
      STELLAR_NETWORK: 'mainnet',
      STELLAR_HORIZON_URL: 'https://horizon.stellar.org',
   });
   assert.equal(valid.success, true, 'Valid Stellar config should parse');

   // 1.3 Invalid STELLAR_NETWORK value is rejected
   const badNetwork = envSchema.safeParse({
      ...BASE_ENV,
      STELLAR_NETWORK: 'devnet',
   });
   assert.equal(badNetwork.success, false, 'Invalid STELLAR_NETWORK should fail');

   // 1.4 Cross-field: production + testnet raises an issue
   const mismatch = envSchema.safeParse({
      ...BASE_ENV,
      MODE: 'production',
      STELLAR_NETWORK: 'testnet',
   });
   assert.equal(mismatch.success, false, 'production MODE with testnet STELLAR_NETWORK should fail');
   if (!mismatch.success) {
      const issue = mismatch.error.issues.find((i: z.ZodIssue) => 
         i.path.includes('STELLAR_NETWORK') && i.message.includes('mainnet')
      );
      assert.ok(issue, 'Error should warn about STELLAR_NETWORK mismatch in production');
   }

   // ── SECTION 2: Source Precedence & Zod Behavior (from main branch) ──
   console.log('Running source precedence and Zod behavior checks...');

   // 2.1 Environment variable takes precedence over default
   {
      const schema = z.object({ PORT: z.coerce.number().default(3000) });
      const result = schema.parse({ PORT: '4000' });
      assert.equal(result.PORT, 4000);
   }

   // 2.2 Type coercion for numbers and booleans
   {
      const schema = z.object({
         PORT: z.coerce.number(),
         ENABLED: z.coerce.boolean(),
      });
      const result = schema.parse({ PORT: '4000', ENABLED: 'true' });
      assert.equal(typeof result.PORT, 'number');
      assert.equal(result.ENABLED, true);
      
      // Note: z.coerce.boolean() uses Boolean(), so any non-empty string is true.
      // If we want 'false' or '0' to be false, we'd need a custom preprocessor.
      assert.equal(schema.parse({ PORT: '3000', ENABLED: 'false' }).ENABLED, true);
   }

   // 2.3 Number range validation
   {
      const schema = z.object({
         JITTER: z.coerce.number().min(0).max(1).default(0.1),
      });
      assert.equal(schema.parse({}).JITTER, 0.1);
      assert.ok(!schema.safeParse({ JITTER: '2' }).success);
      assert.ok(!schema.safeParse({ JITTER: '-1' }).success);
   }

   console.log('✓ All configuration tests passed');
}

run();
