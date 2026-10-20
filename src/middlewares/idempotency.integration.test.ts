// src/middlewares/idempotency.integration.test.ts
// Integration tests for distributed idempotency layer on buy and sell endpoints.
//
// Acceptance Criteria:
//   - First request executes and stores result in Redis with 24-hour TTL
//   - Duplicate key within TTL returns stored response without re-executing
//   - In-flight duplicate blocked up to 5 seconds then returns 409 request_in_progress
//   - Missing header returns 400 with missing_idempotency_key
//   - Keys namespaced by wallet to prevent cross-wallet collisions
//   - Expired key allows a fresh execution (TTL enforced correctly)
//   - No Soroban transaction submitted on a duplicate request

const redisStore = new Map<string, { value: string; ttl: number }>();

jest.mock('../utils/redis.utils', () => ({
   cacheGetRaw: jest.fn(async (key: string) => {
      const entry = redisStore.get(key);
      return entry ? entry.value : null;
   }),
   cacheSetRaw: jest.fn(async (key: string, value: string, ttl: number) => {
      redisStore.set(key, { value, ttl });
   }),
   cacheSetNx: jest.fn(async (key: string, value: string, ttl: number) => {
      if (redisStore.has(key)) return false;
      redisStore.set(key, { value, ttl });
      return true;
   }),
   cacheGetJson: jest.fn(async () => null),
   cacheSetJson: jest.fn(async () => undefined),
   cacheInvalidate: jest.fn(async (...keys: string[]) => {
      for (const k of keys) redisStore.delete(k);
   }),
}));

import express from 'express';
import request from 'supertest';
import {
   idempotencyMiddleware,
   buildIdempotencyCacheKey,
   IDEMPOTENCY_TTL_SECONDS,
} from './idempotency.middleware';

describe('Distributed Idempotency Layer - Buy and Sell Integration', () => {
   let app: express.Express;
   const sorobanSubmitBuyMock = jest.fn();
   const sorobanSubmitSellMock = jest.fn();

   beforeEach(() => {
      redisStore.clear();
      sorobanSubmitBuyMock.mockReset();
      sorobanSubmitSellMock.mockReset();

      app = express();
      app.use(express.json());

      // POST /buy endpoint protected by idempotency layer
      app.post(
         '/buy',
         idempotencyMiddleware({ waitTimeoutMs: 150, pollIntervalMs: 20 }),
         async (req, res) => {
            const { walletAddress, quantity, creatorId } = req.body;
            const sorobanResult = await sorobanSubmitBuyMock({
               walletAddress: walletAddress || req.headers['x-wallet-address'],
               quantity,
               creatorId,
            });
            res.status(200).json({
               success: true,
               data: {
                  transactionHash: sorobanResult.transactionHash,
                  shares: quantity,
                  creatorId,
               },
            });
         }
      );

      // POST /sell endpoint protected by idempotency layer
      app.post(
         '/sell',
         idempotencyMiddleware({ waitTimeoutMs: 150, pollIntervalMs: 20 }),
         async (req, res) => {
            const { walletAddress, quantity, creatorId } = req.body;
            const sorobanResult = await sorobanSubmitSellMock({
               walletAddress: walletAddress || req.headers['x-wallet-address'],
               quantity,
               creatorId,
            });
            res.status(200).json({
               success: true,
               data: {
                  transactionHash: sorobanResult.transactionHash,
                  proceeds: quantity * 10,
                  creatorId,
               },
            });
         }
      );
   });

   describe('Missing Header', () => {
      it('rejects requests missing Idempotency-Key with 400 missing_idempotency_key', async () => {
         const res = await request(app)
            .post('/buy')
            .set('x-wallet-address', 'GBUYER123')
            .send({ creatorId: 'creator-1', quantity: 5 });

         expect(res.status).toBe(400);
         expect(res.body.success).toBe(false);
         expect(res.body.error.code).toBe('missing_idempotency_key');
         expect(sorobanSubmitBuyMock).not.toHaveBeenCalled();
      });
   });

   describe('First Execution and TTL Storage', () => {
      it('executes first request, calls Soroban, and stores result in Redis with 24-hour TTL', async () => {
         sorobanSubmitBuyMock.mockResolvedValueOnce({
            transactionHash: 'tx-soroban-buy-001',
         });

         const idempotencyKey = 'ik-buy-first-exec';
         const wallet = 'GBUYER_FIRST';

         const res = await request(app)
            .post('/buy')
            .set('Idempotency-Key', idempotencyKey)
            .set('x-wallet-address', wallet)
            .send({ creatorId: 'creator-1', quantity: 2 });

         expect(res.status).toBe(200);
         expect(res.body.success).toBe(true);
         expect(res.body.data.transactionHash).toBe('tx-soroban-buy-001');
         expect(sorobanSubmitBuyMock).toHaveBeenCalledTimes(1);

         // Check Redis key format and TTL
         const expectedKey = buildIdempotencyCacheKey(wallet, idempotencyKey);
         expect(expectedKey).toBe(`idempotency:${wallet}:${idempotencyKey}`);
         expect(redisStore.has(expectedKey)).toBe(true);

         const entry = redisStore.get(expectedKey)!;
         expect(entry.ttl).toBe(IDEMPOTENCY_TTL_SECONDS);
         expect(entry.ttl).toBe(86400); // 24 hours in seconds

         const stored = JSON.parse(entry.value);
         expect(stored.statusCode).toBe(200);
         expect(stored.body).toEqual(res.body);
         expect(typeof stored.resolvedAt).toBe('string');
      });
   });

   describe('Duplicate Request Replay (No Soroban / DB re-execution)', () => {
      it('returns stored response immediately without re-submitting Soroban transaction', async () => {
         sorobanSubmitBuyMock.mockResolvedValueOnce({
            transactionHash: 'tx-soroban-buy-unique',
         });

         const idempotencyKey = 'ik-retry-test';
         const wallet = 'GBUYER_RETRY';

         // First request
         const res1 = await request(app)
            .post('/buy')
            .set('Idempotency-Key', idempotencyKey)
            .set('x-wallet-address', wallet)
            .send({ creatorId: 'creator-1', quantity: 3 });

         expect(res1.status).toBe(200);
         expect(res1.body.data.transactionHash).toBe('tx-soroban-buy-unique');
         expect(sorobanSubmitBuyMock).toHaveBeenCalledTimes(1);

         // Duplicate retry request with same key
         const res2 = await request(app)
            .post('/buy')
            .set('Idempotency-Key', idempotencyKey)
            .set('x-wallet-address', wallet)
            .send({ creatorId: 'creator-1', quantity: 3 });

         expect(res2.status).toBe(200);
         expect(res2.headers['x-idempotent-replay']).toBe('true');
         expect(res2.body).toEqual(res1.body);

         // Crucial acceptance criteria: Soroban was NOT submitted again
         expect(sorobanSubmitBuyMock).toHaveBeenCalledTimes(1);
      });

      it('also works for POST /sell endpoints', async () => {
         sorobanSubmitSellMock.mockResolvedValueOnce({
            transactionHash: 'tx-soroban-sell-001',
         });

         const idempotencyKey = 'ik-sell-retry';
         const wallet = 'GSELLER_RETRY';

         // First sell request
         const res1 = await request(app)
            .post('/sell')
            .set('Idempotency-Key', idempotencyKey)
            .set('x-wallet-address', wallet)
            .send({ creatorId: 'creator-1', quantity: 1 });

         expect(res1.status).toBe(200);
         expect(res1.body.data.transactionHash).toBe('tx-soroban-sell-001');
         expect(sorobanSubmitSellMock).toHaveBeenCalledTimes(1);

         // Duplicate sell request
         const res2 = await request(app)
            .post('/sell')
            .set('Idempotency-Key', idempotencyKey)
            .set('x-wallet-address', wallet)
            .send({ creatorId: 'creator-1', quantity: 1 });

         expect(res2.status).toBe(200);
         expect(res2.headers['x-idempotent-replay']).toBe('true');
         expect(res2.body).toEqual(res1.body);
         expect(sorobanSubmitSellMock).toHaveBeenCalledTimes(1);
      });
   });

   describe('In-Flight Duplicate Handling', () => {
      it('blocks duplicate for up to timeout and returns 409 request_in_progress when first request stays in-flight', async () => {
         const idempotencyKey = 'ik-inflight-timeout';
         const wallet = 'GBUYER_CONCURRENT';
         const key = buildIdempotencyCacheKey(wallet, idempotencyKey);

         // Simulate first request currently in flight
         redisStore.set(key, {
            value: JSON.stringify({ inFlight: true, startedAt: Date.now() }),
            ttl: 60,
         });

         const startTime = Date.now();
         const res = await request(app)
            .post('/buy')
            .set('Idempotency-Key', idempotencyKey)
            .set('x-wallet-address', wallet)
            .send({ creatorId: 'creator-1', quantity: 1 });

         const elapsed = Date.now() - startTime;
         expect(elapsed).toBeGreaterThanOrEqual(140); // Blocked for ~150ms timeout
         expect(res.status).toBe(409);
         expect(res.body.success).toBe(false);
         expect(res.body.error.code).toBe('request_in_progress');
         expect(sorobanSubmitBuyMock).not.toHaveBeenCalled();
      });

      it('blocks duplicate and returns the resolved result when first request completes within wait window', async () => {
         const idempotencyKey = 'ik-inflight-resolving';
         const wallet = 'GBUYER_CONCURRENT_2';
         const key = buildIdempotencyCacheKey(wallet, idempotencyKey);

         // Set key to in-flight
         redisStore.set(key, {
            value: JSON.stringify({ inFlight: true, startedAt: Date.now() }),
            ttl: 60,
         });

         // Simulate first request completing in 40ms
         setTimeout(() => {
            redisStore.set(key, {
               value: JSON.stringify({
                  statusCode: 200,
                  body: {
                     success: true,
                     data: { transactionHash: 'tx-completed-in-time' },
                  },
                  resolvedAt: new Date().toISOString(),
               }),
               ttl: IDEMPOTENCY_TTL_SECONDS,
            });
         }, 40);

         const res = await request(app)
            .post('/buy')
            .set('Idempotency-Key', idempotencyKey)
            .set('x-wallet-address', wallet)
            .send({ creatorId: 'creator-1', quantity: 1 });

         expect(res.status).toBe(200);
         expect(res.headers['x-idempotent-replay']).toBe('true');
         expect(res.body.data.transactionHash).toBe('tx-completed-in-time');
         expect(sorobanSubmitBuyMock).not.toHaveBeenCalled();
      });
   });

   describe('Wallet Address Namespacing', () => {
      it('namespaces keys by wallet to prevent cross-wallet collisions with same idempotency key', async () => {
         sorobanSubmitBuyMock
            .mockResolvedValueOnce({ transactionHash: 'tx-wallet-a' })
            .mockResolvedValueOnce({ transactionHash: 'tx-wallet-b' });

         const sharedKey = 'common-ik-100';
         const walletA = 'GWALLET_AAA';
         const walletB = 'GWALLET_BBB';

         // Wallet A submits with common-ik-100
         const resA = await request(app)
            .post('/buy')
            .set('Idempotency-Key', sharedKey)
            .set('x-wallet-address', walletA)
            .send({ creatorId: 'creator-1', quantity: 1 });

         expect(resA.status).toBe(200);
         expect(resA.body.data.transactionHash).toBe('tx-wallet-a');

         // Wallet B submits with the same key common-ik-100 -> MUST NOT collide or return Wallet A's response
         const resB = await request(app)
            .post('/buy')
            .set('Idempotency-Key', sharedKey)
            .set('x-wallet-address', walletB)
            .send({ creatorId: 'creator-1', quantity: 2 });

         expect(resB.status).toBe(200);
         expect(resB.body.data.transactionHash).toBe('tx-wallet-b');

         // Both calls executed independently
         expect(sorobanSubmitBuyMock).toHaveBeenCalledTimes(2);

         expect(redisStore.has(`idempotency:${walletA}:${sharedKey}`)).toBe(
            true
         );
         expect(redisStore.has(`idempotency:${walletB}:${sharedKey}`)).toBe(
            true
         );
      });
   });

   describe('Key Expiration (TTL Enforced)', () => {
      it('allows fresh execution when key has expired in Redis', async () => {
         sorobanSubmitBuyMock
            .mockResolvedValueOnce({ transactionHash: 'tx-first-execution' })
            .mockResolvedValueOnce({
               transactionHash: 'tx-fresh-after-expiry',
            });

         const idempotencyKey = 'ik-expiry-test';
         const wallet = 'GBUYER_EXPIRY';
         const key = buildIdempotencyCacheKey(wallet, idempotencyKey);

         // First execution
         const res1 = await request(app)
            .post('/buy')
            .set('Idempotency-Key', idempotencyKey)
            .set('x-wallet-address', wallet)
            .send({ creatorId: 'creator-1', quantity: 1 });

         expect(res1.status).toBe(200);
         expect(res1.body.data.transactionHash).toBe('tx-first-execution');
         expect(sorobanSubmitBuyMock).toHaveBeenCalledTimes(1);

         // Simulate TTL expiration in Redis
         redisStore.delete(key);

         // Subsequent execution with expired key runs fresh
         const res2 = await request(app)
            .post('/buy')
            .set('Idempotency-Key', idempotencyKey)
            .set('x-wallet-address', wallet)
            .send({ creatorId: 'creator-1', quantity: 1 });

         expect(res2.status).toBe(200);
         expect(res2.headers['x-idempotent-replay']).toBeUndefined();
         expect(res2.body.data.transactionHash).toBe('tx-fresh-after-expiry');
         expect(sorobanSubmitBuyMock).toHaveBeenCalledTimes(2);
      });
   });
});
