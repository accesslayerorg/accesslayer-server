/// <reference types="node" />
import { strict as assert } from 'assert';
import { envSchema } from './config.schema';
import { z } from 'zod';

/**
 * Minimal valid env fixture — satisfies every required field in envSchema
 * so individual tests can override only the Stellar-specific values.
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
   // ── 1. Defaults are applied when Stellar env vars are omitted ──
   const defaults = envSchema.parse(BASE_ENV);
   assert.equal(
      defaults.STELLAR_NETWORK,
      'testnet',
      'Default STELLAR_NETWORK should be "testnet"'
   );
   assert.equal(
      defaults.STELLAR_HORIZON_URL,
      'https://horizon-testnet.stellar.org',
      'Default STELLAR_HORIZON_URL should be the testnet endpoint'
   );
   assert.equal(
      defaults.STELLAR_SOROBAN_RPC_URL,
      'https://soroban-testnet.stellar.org',
      'Default STELLAR_SOROBAN_RPC_URL should be the testnet endpoint'
   );

   // ── 2. Valid explicit Stellar config is accepted ──
   const valid = envSchema.safeParse({
      ...BASE_ENV,
      STELLAR_NETWORK: 'mainnet',
      STELLAR_HORIZON_URL: 'https://horizon.stellar.org',
      STELLAR_SOROBAN_RPC_URL:
         'https://soroban-rpc.mainnet.stellar.gateway.fm',
   });
   assert.equal(valid.success, true, 'Valid Stellar config should parse');

   // ── 3. Invalid STELLAR_NETWORK value is rejected ──
   const badNetwork = envSchema.safeParse({
      ...BASE_ENV,
      STELLAR_NETWORK: 'devnet',
   });
   assert.equal(
      badNetwork.success,
      false,
      'Invalid STELLAR_NETWORK should fail'
   );
   if (!badNetwork.success) {
      const issue = badNetwork.error.issues.find(
         (i: z.ZodIssue) => i.path.includes('STELLAR_NETWORK')
      );
      assert.ok(issue, 'Error should reference STELLAR_NETWORK');
   }

   // ── 4. Invalid STELLAR_HORIZON_URL is rejected ──
   const badHorizon = envSchema.safeParse({
      ...BASE_ENV,
      STELLAR_HORIZON_URL: 'not-a-url',
   });
   assert.equal(
      badHorizon.success,
      false,
      'Invalid STELLAR_HORIZON_URL should fail'
   );
   if (!badHorizon.success) {
      const issue = badHorizon.error.issues.find(
         (i: z.ZodIssue) => i.path.includes('STELLAR_HORIZON_URL')
      );
      assert.ok(issue, 'Error should reference STELLAR_HORIZON_URL');
   }

   // ── 5. Invalid STELLAR_SOROBAN_RPC_URL is rejected ──
   const badSoroban = envSchema.safeParse({
      ...BASE_ENV,
      STELLAR_SOROBAN_RPC_URL: 'not-a-url',
   });
   assert.equal(
      badSoroban.success,
      false,
      'Invalid STELLAR_SOROBAN_RPC_URL should fail'
   );
   if (!badSoroban.success) {
      const issue = badSoroban.error.issues.find(
         (i: z.ZodIssue) => i.path.includes('STELLAR_SOROBAN_RPC_URL')
      );
      assert.ok(issue, 'Error should reference STELLAR_SOROBAN_RPC_URL');
   }

   // ── 6. Cross-field: production + testnet raises an issue ──
   const mismatch = envSchema.safeParse({
      ...BASE_ENV,
      MODE: 'production',
      STELLAR_NETWORK: 'testnet',
   });
   assert.equal(
      mismatch.success,
      false,
      'production MODE with testnet STELLAR_NETWORK should fail'
   );
   if (!mismatch.success) {
      const issue = mismatch.error.issues.find(
         (i: z.ZodIssue) =>
            i.path.includes('STELLAR_NETWORK') &&
            i.message.includes('mainnet')
      );
      assert.ok(
         issue,
         'Error should warn about STELLAR_NETWORK mismatch in production'
      );
   }

   console.log('config.test: all Stellar network validation tests passed');
}

run();
