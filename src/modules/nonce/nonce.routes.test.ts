// src/modules/nonce/nonce.routes.test.ts
// Integration tests for Nonce management API endpoints (#1039).

const mockCache = new Map<string, any>();

jest.mock('../../utils/redis.utils', () => ({
   cacheGet: jest.fn(async (key: string) =>
      mockCache.has(key) ? JSON.stringify(mockCache.get(key)) : null
   ),
   cacheGetJson: jest.fn(async (key: string) =>
      mockCache.has(key) ? mockCache.get(key) : null
   ),
   cacheSetJson: jest.fn(async (key: string, val: any) => {
      mockCache.set(key, val);
   }),
   cacheInvalidate: jest.fn(async (key: string) => {
      mockCache.delete(key);
   }),
}));

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      isLevelEnabled: jest.fn().mockReturnValue(false),
   },
}));

import express from 'express';
import supertest from 'supertest';
import nonceRouter from './nonce.routes';
import { resetNonceStateForTests } from './nonce.service';
import { requireNonceReplayProtection } from './nonce.middleware';

const app = express();
app.use(express.json());
app.use('/api/v1/nonce', nonceRouter);
app.use('/nonce', nonceRouter);

// Test harness endpoint protected by requireNonceReplayProtection middleware
app.post(
   '/api/v1/test-protected-action',
   requireNonceReplayProtection({ action: 'test:protected_action' }),
   (_req, res) => {
      res.json({ success: true, message: 'Action executed' });
   }
);

const VALID_WALLET = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const ANOTHER_WALLET =
   'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2KM';

describe('Nonce Management API Endpoints (#1039)', () => {
   beforeEach(() => {
      mockCache.clear();
      resetNonceStateForTests();
      jest.clearAllMocks();
   });

   describe('GET /api/v1/nonce', () => {
      it('returns 200 and fetches initial nonce (cached: false) on cold cache', async () => {
         const res = await supertest(app)
            .get('/api/v1/nonce')
            .query({ wallet: VALID_WALLET });

         expect(res.status).toBe(200);
         expect(res.body).toEqual({
            success: true,
            data: {
               wallet: VALID_WALLET,
               nonce: 0,
               cached: false,
            },
         });
      });

      it('returns cached nonce (cached: true) on subsequent request', async () => {
         const first = await supertest(app)
            .get('/api/v1/nonce')
            .query({ wallet: VALID_WALLET });
         expect(first.status).toBe(200);
         expect(first.body.data.cached).toBe(false);

         const second = await supertest(app)
            .get('/api/v1/nonce')
            .query({ wallet: VALID_WALLET });
         expect(second.status).toBe(200);
         expect(second.body.data.cached).toBe(true);
         expect(second.body.data.nonce).toBe(0);
      });

      it('returns 400 when wallet query parameter is missing', async () => {
         const res = await supertest(app).get('/api/v1/nonce');

         expect(res.status).toBe(400);
         expect(res.body.success).toBe(false);
         expect(res.body.error.details[0].field).toBe('wallet');
      });

      it('returns 400 when wallet is not a valid Stellar address', async () => {
         const res = await supertest(app)
            .get('/api/v1/nonce')
            .query({ wallet: 'INVALID_WALLET_ADDRESS' });

         expect(res.status).toBe(400);
         expect(res.body.success).toBe(false);
         expect(res.body.error.details[0].message).toContain('Stellar');
      });
   });

   describe('POST /api/v1/nonce/consume', () => {
      it('consumes a valid nonce and returns nextNonce', async () => {
         const res = await supertest(app).post('/api/v1/nonce/consume').send({
            wallet: VALID_WALLET,
            nonce: 0,
            action: 'governance:create_proposal',
         });

         expect(res.status).toBe(200);
         expect(res.body.success).toBe(true);
         expect(res.body.data).toEqual({
            wallet: VALID_WALLET,
            consumedNonce: 0,
            nextNonce: 1,
         });

         // Check GET /nonce immediately returns next nonce and cached is false (cache was invalidated)
         const check = await supertest(app)
            .get('/api/v1/nonce')
            .query({ wallet: VALID_WALLET });

         expect(check.status).toBe(200);
         expect(check.body.data.nonce).toBe(1);
         expect(check.body.data.cached).toBe(false);
      });

      it('immediately rejects replayed nonce with 409 Conflict', async () => {
         // First consume succeeds
         const first = await supertest(app).post('/api/v1/nonce/consume').send({
            wallet: VALID_WALLET,
            nonce: 0,
            action: 'admin:pause',
         });
         expect(first.status).toBe(200);

         // Second consume with the same nonce fails with 409
         const replay = await supertest(app)
            .post('/api/v1/nonce/consume')
            .send({
               wallet: VALID_WALLET,
               nonce: 0,
               action: 'admin:pause',
            });

         expect(replay.status).toBe(409);
         expect(replay.body.success).toBe(false);
         expect(replay.body.error.message).toContain('already been consumed');
      });

      it('returns 400 when attempting to consume out-of-order nonce', async () => {
         const res = await supertest(app).post('/api/v1/nonce/consume').send({
            wallet: VALID_WALLET,
            nonce: 99,
         });

         expect(res.status).toBe(400);
         expect(res.body.success).toBe(false);
         expect(res.body.error.message).toContain('expected 0, received 99');
      });

      it('returns 400 on invalid request body', async () => {
         const missingNonce = await supertest(app)
            .post('/api/v1/nonce/consume')
            .send({ wallet: VALID_WALLET });
         expect(missingNonce.status).toBe(400);

         const negativeNonce = await supertest(app)
            .post('/api/v1/nonce/consume')
            .send({ wallet: VALID_WALLET, nonce: -1 });
         expect(negativeNonce.status).toBe(400);

         const invalidWallet = await supertest(app)
            .post('/api/v1/nonce/consume')
            .send({ wallet: 'invalid-wallet', nonce: 0 });
         expect(invalidWallet.status).toBe(400);
      });

      it('manages nonces independently per wallet', async () => {
         // Wallet A consumes nonce 0
         const resA = await supertest(app)
            .post('/api/v1/nonce/consume')
            .send({ wallet: VALID_WALLET, nonce: 0 });
         expect(resA.status).toBe(200);

         // Wallet B can still consume nonce 0
         const resB = await supertest(app)
            .post('/api/v1/nonce/consume')
            .send({ wallet: ANOTHER_WALLET, nonce: 0 });
         expect(resB.status).toBe(200);

         // Wallet A cannot consume nonce 0 again
         const replayA = await supertest(app)
            .post('/api/v1/nonce/consume')
            .send({ wallet: VALID_WALLET, nonce: 0 });
         expect(replayA.status).toBe(409);
      });
   });

   describe('requireNonceReplayProtection middleware', () => {
      it('allows request with valid nonce and advances expected nonce', async () => {
         const res = await supertest(app)
            .post('/api/v1/test-protected-action')
            .send({ wallet: VALID_WALLET, nonce: 0 });

         expect(res.status).toBe(200);
         expect(res.body.success).toBe(true);

         // Replay of the same nonce is rejected with 409
         const replay = await supertest(app)
            .post('/api/v1/test-protected-action')
            .send({ wallet: VALID_WALLET, nonce: 0 });

         expect(replay.status).toBe(409);
         expect(replay.body.error.message).toContain('already been consumed');

         // Next nonce (1) is accepted
         const next = await supertest(app)
            .post('/api/v1/test-protected-action')
            .send({ wallet: VALID_WALLET, nonce: 1 });

         expect(next.status).toBe(200);
      });

      it('supports x-nonce header for signed actions', async () => {
         const res = await supertest(app)
            .post('/api/v1/test-protected-action')
            .set('x-nonce', '0')
            .send({ signer: ANOTHER_WALLET });

         expect(res.status).toBe(200);

         // Replayed header is rejected with 409
         const replay = await supertest(app)
            .post('/api/v1/test-protected-action')
            .set('x-nonce', '0')
            .send({ signer: ANOTHER_WALLET });

         expect(replay.status).toBe(409);
      });
   });

   describe('Direct root /nonce endpoints', () => {
      it('supports GET /nonce?wallet= directly', async () => {
         const res = await supertest(app)
            .get('/nonce')
            .query({ wallet: VALID_WALLET });

         expect(res.status).toBe(200);
         expect(res.body.success).toBe(true);
         expect(res.body.data.wallet).toBe(VALID_WALLET);
      });

      it('supports POST /nonce/consume directly', async () => {
         const res = await supertest(app)
            .post('/nonce/consume')
            .send({
               wallet: VALID_WALLET,
               nonce: 0,
               action: 'direct_root_call',
            });

         expect(res.status).toBe(200);
         expect(res.body.success).toBe(true);
         expect(res.body.data.consumedNonce).toBe(0);
         expect(res.body.data.nextNonce).toBe(1);
      });
   });
});
