// src/middlewares/stellar-signature.middleware.test.ts
// Unit / Integration tests for Stellar signature verification middleware.

const mockCacheStore = new Map<string, any>();

jest.mock('../utils/redis.utils', () => ({
   cacheGetJson: jest.fn(async (key: string) =>
      mockCacheStore.has(key) ? mockCacheStore.get(key) : null
   ),
   cacheSetJson: jest.fn(async (key: string, val: any) => {
      mockCacheStore.set(key, val);
   }),
   cacheInvalidate: jest.fn(async (key: string) => {
      mockCacheStore.delete(key);
   }),
}));

import express from 'express';
import supertest from 'supertest';
import { Keypair } from '@stellar/stellar-base';
import { createHash } from 'crypto';
import { requireStellarSignature } from './stellar-signature.middleware';
import { resetNonceStateForTests } from '../modules/nonce';

const testApp = express();
testApp.use(express.json());
testApp.put('/test-sig', requireStellarSignature(), (_req, res) => {
   res.status(202).json({ success: true });
});

function buildCanonicalMessage(body: unknown, timestamp: string): Buffer {
   const bodyJson = JSON.stringify(body);
   const payload = `${bodyJson}${timestamp}`;
   return createHash('sha256').update(payload, 'utf8').digest();
}

describe('#418 Stellar signature verification middleware', () => {
   let keypair: Keypair;

   beforeEach(() => {
      mockCacheStore.clear();
      keypair = Keypair.random();
      resetNonceStateForTests();
   });

   it('rejects request with missing signature headers', async () => {
      const res = await supertest(testApp)
         .put('/test-sig')
         .send({ displayName: 'Test' });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
   });

   it('rejects request with expired timestamp', async () => {
      const body = { displayName: 'Test' };
      const timestamp = (Date.now() - 10 * 60 * 1000).toString(); // 10 min ago
      const message = buildCanonicalMessage(body, timestamp);
      const signature = keypair.sign(message).toString('base64');

      const res = await supertest(testApp)
         .put('/test-sig')
         .set('x-wallet-address', keypair.publicKey())
         .set('x-wallet-signature', signature)
         .set('x-timestamp', timestamp)
         .send(body);

      expect(res.status).toBe(401);
      expect(res.body.error.message).toContain('expired');
   });

   it('rejects request with tampered body', async () => {
      const originalBody = { displayName: 'Original' };
      const timestamp = Date.now().toString();
      const message = buildCanonicalMessage(originalBody, timestamp);
      const signature = keypair.sign(message).toString('base64');

      // Send different body than what was signed
      const tamperedBody = { displayName: 'Tampered' };

      const res = await supertest(testApp)
         .put('/test-sig')
         .set('x-wallet-address', keypair.publicKey())
         .set('x-wallet-signature', signature)
         .set('x-timestamp', timestamp)
         .send(tamperedBody);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(res.body.error.message).toContain('tampered');
   });

   it('rejects request signed with wrong keypair', async () => {
      const wrongKeypair = Keypair.random();
      const body = { displayName: 'Test' };
      const timestamp = Date.now().toString();
      const message = buildCanonicalMessage(body, timestamp);
      const signature = wrongKeypair.sign(message).toString('base64');

      const res = await supertest(testApp)
         .put('/test-sig')
         .set('x-wallet-address', keypair.publicKey()) // Correct address
         .set('x-wallet-signature', signature) // But wrong signature
         .set('x-timestamp', timestamp)
         .send(body);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
   });

   it('accepts valid signature and updates profile', async () => {
      const body = { displayName: 'Valid Update' };
      const timestamp = Date.now().toString();
      const message = buildCanonicalMessage(body, timestamp);
      const signature = keypair.sign(message).toString('base64');

      const res = await supertest(testApp)
         .put('/test-sig')
         .set('x-wallet-address', keypair.publicKey())
         .set('x-wallet-signature', signature)
         .set('x-timestamp', timestamp)
         .send(body);

      expect(res.status).toBe(202);
      expect(res.body.success).toBe(true);
   });

   it('rejects invalid Stellar address format', async () => {
      const body = { displayName: 'Test' };
      const timestamp = Date.now().toString();
      const message = buildCanonicalMessage(body, timestamp);
      const signature = keypair.sign(message).toString('base64');

      const res = await supertest(testApp)
         .put('/test-sig')
         .set('x-wallet-address', 'INVALID_ADDRESS')
         .set('x-wallet-signature', signature)
         .set('x-timestamp', timestamp)
         .send(body);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('BAD_REQUEST');
   });

   it('accepts valid x-nonce and rejects replay with 409 Conflict (#1039)', async () => {
      const body = { displayName: 'Nonce Protected Update' };
      const timestamp = Date.now().toString();
      const message = buildCanonicalMessage(body, timestamp);
      const signature = keypair.sign(message).toString('base64');

      const res = await supertest(testApp)
         .put('/test-sig')
         .set('x-wallet-address', keypair.publicKey())
         .set('x-wallet-signature', signature)
         .set('x-timestamp', timestamp)
         .set('x-nonce', '0')
         .send(body);

      expect(res.status).toBe(202);
      expect(res.body.success).toBe(true);

      // Replaying the exact same nonce should immediately return 409 Conflict
      const replay = await supertest(testApp)
         .put('/test-sig')
         .set('x-wallet-address', keypair.publicKey())
         .set('x-wallet-signature', signature)
         .set('x-timestamp', timestamp)
         .set('x-nonce', '0')
         .send(body);

      expect(replay.status).toBe(409);
      expect(replay.body.error.message).toContain('already been consumed');
   });
});
