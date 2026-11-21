// src/__tests__/integration/idempotency.integration.test.ts
// Integration tests for distributed idempotency layer on buy and sell endpoints (#725)
//
// Acceptance Criteria:
//   - First request executes and stores result in Redis with 24-hour TTL
//   - Duplicate key within TTL returns stored response without re-executing
//   - In-flight duplicate blocked up to 5 seconds then returns 409 request_in_progress
//   - Missing header returns 400 with missing_idempotency_key
//   - Keys namespaced by wallet to prevent cross-wallet collisions
//   - Expired key allows a fresh execution (TTL enforced correctly)
//   - No Soroban transaction submitted on a duplicate request

const redisStore = new Map<
   string,
   { value: string; expires: number; ttl: number }
>();

jest.mock('../../utils/redis.utils', () => ({
   cacheGetRaw: jest.fn(async (key: string) => {
      const item = redisStore.get(key);
      if (!item) return null;
      if (item.expires <= Date.now()) {
         redisStore.delete(key);
         return null;
      }
      return item.value;
   }),
   cacheSetRaw: jest.fn(async (key: string, value: string, ttl: number) => {
      redisStore.set(key, { value, expires: Date.now() + ttl * 1000, ttl });
   }),
   cacheSetRawNx: jest.fn(async (key: string, value: string, ttl: number) => {
      const existing = redisStore.get(key);
      if (existing && existing.expires > Date.now()) {
         return false;
      }
      redisStore.set(key, { value, expires: Date.now() + ttl * 1000, ttl });
      return true;
   }),
   cacheGetJson: jest.fn(async () => null),
   cacheSetJson: jest.fn(async () => undefined),
   cacheInvalidate: jest.fn(async (...keys: string[]) => {
      for (const k of keys) redisStore.delete(k);
   }),
   getRedisClient: jest.fn(() => null),
   getRedis: jest.fn(() => null),
   redis: jest.fn(() => null),
   disconnectRedis: jest.fn(async () => undefined),
}));

import express, { Request, Response } from 'express';
import supertest from 'supertest';
import { Keypair } from '@stellar/stellar-base';
import { buildAuthHeaders } from '../../utils/test/auth-request.utils';
import { requireStellarSignature } from '../../middlewares/stellar-signature.middleware';
import {
   idempotencyMiddleware,
   IDEMPOTENCY_TTL_SECONDS,
   buildIdempotencyCacheKey,
} from '../../middlewares/idempotency.middleware';

describe('Distributed Idempotency Layer Integration Tests (#725)', () => {
   let app: express.Express;
   let sorobanBuySubmit: jest.Mock;
   let databaseSellSubmit: jest.Mock;

   beforeEach(() => {
      redisStore.clear();
      jest.clearAllMocks();

      app = express();
      app.use(express.json());

      sorobanBuySubmit = jest.fn().mockImplementation(async body => {
         return {
            transactionHash:
               'soroban-tx-' + Math.random().toString(36).substring(2, 9),
            quantity: body.quantity,
            executedAt: new Date().toISOString(),
         };
      });

      databaseSellSubmit = jest.fn().mockImplementation(async body => {
         return {
            transactionHash:
               'stellar-sell-tx-' + Math.random().toString(36).substring(2, 9),
            payoutXlm: body.quantity * 5,
            executedAt: new Date().toISOString(),
         };
      });

      // Buy endpoint with idempotency middleware
      app.post(
         '/api/v1/creators/:id/buy',
         requireStellarSignature(),
         idempotencyMiddleware(),
         async (req: Request, res: Response) => {
            const result = await sorobanBuySubmit(req.body);
            res.status(200).json({ success: true, data: result });
         }
      );

      // Sell endpoint with idempotency middleware
      app.post(
         '/api/v1/creators/:id/sell',
         requireStellarSignature(),
         idempotencyMiddleware(),
         async (req: Request, res: Response) => {
            const result = await databaseSellSubmit(req.body);
            res.status(200).json({ success: true, data: result });
         }
      );

      // Shorthand POST /buy and POST /sell endpoints with configured timeout for testing
      app.post(
         '/buy',
         requireStellarSignature(),
         idempotencyMiddleware({ timeoutMs: 300, pollIntervalMs: 30 }),
         async (req: Request, res: Response) => {
            const result = await sorobanBuySubmit(req.body);
            res.status(200).json({ success: true, data: result });
         }
      );

      app.post(
         '/sell',
         requireStellarSignature(),
         idempotencyMiddleware({ timeoutMs: 300, pollIntervalMs: 30 }),
         async (req: Request, res: Response) => {
            const result = await databaseSellSubmit(req.body);
            res.status(200).json({ success: true, data: result });
         }
      );
   });

   describe('Missing Idempotency-Key Header', () => {
      it('rejects requests missing Idempotency-Key with 400 missing_idempotency_key', async () => {
         const wallet = Keypair.random();
         const body = { quantity: 1, key_cost_xlm: 10 };
         const authHeaders = buildAuthHeaders(body, wallet);

         const res = await supertest(app)
            .post('/api/v1/creators/creator-1/buy')
            .set(authHeaders)
            .send(body);

         expect(res.status).toBe(400);
         expect(res.body.success).toBe(false);
         expect(res.body.error.code).toBe('missing_idempotency_key');
         expect(sorobanBuySubmit).not.toHaveBeenCalled();
      });

      it('rejects POST /sell missing Idempotency-Key with 400 missing_idempotency_key', async () => {
         const wallet = Keypair.random();
         const body = { quantity: 2, min_price: 5 };
         const authHeaders = buildAuthHeaders(body, wallet);

         const res = await supertest(app)
            .post('/api/v1/creators/creator-1/sell')
            .set(authHeaders)
            .send(body);

         expect(res.status).toBe(400);
         expect(res.body.success).toBe(false);
         expect(res.body.error.code).toBe('missing_idempotency_key');
         expect(databaseSellSubmit).not.toHaveBeenCalled();
      });
   });

   describe('First Execution & Storage in Redis', () => {
      it('executes buy and stores { statusCode, body, resolvedAt } in Redis with 24-hour TTL', async () => {
         const wallet = Keypair.random();
         const body = { quantity: 1, key_cost_xlm: 10 };
         const idempotencyKey = 'buy-key-001';
         const authHeaders = buildAuthHeaders(body, wallet);

         const res = await supertest(app)
            .post('/api/v1/creators/creator-1/buy')
            .set(authHeaders)
            .set('Idempotency-Key', idempotencyKey)
            .send(body);

         expect(res.status).toBe(200);
         expect(res.body.success).toBe(true);
         expect(sorobanBuySubmit).toHaveBeenCalledTimes(1);

         const redisKey = buildIdempotencyCacheKey(
            wallet.publicKey(),
            idempotencyKey
         );
         expect(redisStore.has(redisKey)).toBe(true);

         const storedEntry = redisStore.get(redisKey)!;
         expect(storedEntry.ttl).toBe(IDEMPOTENCY_TTL_SECONDS); // 24-hour TTL (86400s)

         const parsed = JSON.parse(storedEntry.value);
         expect(parsed.statusCode).toBe(200);
         expect(parsed.body).toEqual(res.body);
         expect(typeof parsed.resolvedAt).toBe('string');
         expect(new Date(parsed.resolvedAt).getTime()).not.toBeNaN();
      });

      it('executes sell and stores result in Redis under namespaced wallet key', async () => {
         const wallet = Keypair.random();
         const body = { quantity: 3, min_price: 4 };
         const idempotencyKey = 'sell-key-001';
         const authHeaders = buildAuthHeaders(body, wallet);

         const res = await supertest(app)
            .post('/api/v1/creators/creator-1/sell')
            .set(authHeaders)
            .set('Idempotency-Key', idempotencyKey)
            .send(body);

         expect(res.status).toBe(200);
         expect(databaseSellSubmit).toHaveBeenCalledTimes(1);

         const redisKey = buildIdempotencyCacheKey(
            wallet.publicKey(),
            idempotencyKey
         );
         expect(redisStore.has(redisKey)).toBe(true);

         const stored = JSON.parse(redisStore.get(redisKey)!.value);
         expect(stored.statusCode).toBe(200);
         expect(stored.body).toEqual(res.body);
         expect(stored.resolvedAt).toBeDefined();
      });
   });

   describe('Duplicate Request Handling', () => {
      it('returns stored response on duplicate request within TTL without re-executing Soroban', async () => {
         const wallet = Keypair.random();
         const body = { quantity: 1, key_cost_xlm: 10 };
         const idempotencyKey = 'buy-key-duplicate';
         const authHeaders = buildAuthHeaders(body, wallet);

         // First request: executes
         const res1 = await supertest(app)
            .post('/api/v1/creators/creator-1/buy')
            .set(authHeaders)
            .set('Idempotency-Key', idempotencyKey)
            .send(body);

         expect(res1.status).toBe(200);
         expect(sorobanBuySubmit).toHaveBeenCalledTimes(1);
         const firstTxHash = res1.body.data.transactionHash;

         // Second request (duplicate): same key within TTL
         const res2 = await supertest(app)
            .post('/api/v1/creators/creator-1/buy')
            .set(authHeaders)
            .set('Idempotency-Key', idempotencyKey)
            .send(body);

         expect(res2.status).toBe(200);
         expect(res2.headers['x-idempotent-replay']).toBe('true');
         expect(res2.body).toEqual(res1.body);
         expect(res2.body.data.transactionHash).toBe(firstTxHash);

         // Crucial acceptance criterion: No Soroban transaction submitted on a duplicate request
         expect(sorobanBuySubmit).toHaveBeenCalledTimes(1);
      });

      it('returns stored sell response without re-executing database operations', async () => {
         const wallet = Keypair.random();
         const body = { quantity: 5, min_price: 10 };
         const idempotencyKey = 'sell-key-duplicate';
         const authHeaders = buildAuthHeaders(body, wallet);

         const res1 = await supertest(app)
            .post('/api/v1/creators/creator-1/sell')
            .set(authHeaders)
            .set('Idempotency-Key', idempotencyKey)
            .send(body);

         expect(res1.status).toBe(200);
         expect(databaseSellSubmit).toHaveBeenCalledTimes(1);

         const res2 = await supertest(app)
            .post('/api/v1/creators/creator-1/sell')
            .set(authHeaders)
            .set('Idempotency-Key', idempotencyKey)
            .send(body);

         expect(res2.status).toBe(200);
         expect(res2.headers['x-idempotent-replay']).toBe('true');
         expect(res2.body).toEqual(res1.body);
         expect(databaseSellSubmit).toHaveBeenCalledTimes(1);
      });
   });

   describe('Concurrent In-Flight Requests', () => {
      it('blocks duplicate when first request is in-flight and returns 409 request_in_progress on timeout', async () => {
         const wallet = Keypair.random();
         const body = { quantity: 1, key_cost_xlm: 10 };
         const idempotencyKey = 'in-flight-key-409';
         const authHeaders = buildAuthHeaders(body, wallet);

         // Mark key as in-flight in Redis
         const redisKey = buildIdempotencyCacheKey(
            wallet.publicKey(),
            idempotencyKey
         );
         redisStore.set(redisKey, {
            value: JSON.stringify({ inProgress: true, startedAt: Date.now() }),
            expires: Date.now() + 60000,
            ttl: 60,
         });

         const startTime = Date.now();
         const res = await supertest(app)
            .post('/buy')
            .set(authHeaders)
            .set('Idempotency-Key', idempotencyKey)
            .send(body);

         const elapsed = Date.now() - startTime;
         expect(elapsed).toBeGreaterThanOrEqual(250); // Waited for timeout
         expect(res.status).toBe(409);
         expect(res.body.success).toBe(false);
         expect(res.body.error.code).toBe('request_in_progress');
         expect(sorobanBuySubmit).not.toHaveBeenCalled();
      });

      it('blocks duplicate when in-flight and returns the resolved result when first request completes', async () => {
         const wallet = Keypair.random();
         const body = { quantity: 1, key_cost_xlm: 10 };
         const idempotencyKey = 'in-flight-resolving';
         const authHeaders = buildAuthHeaders(body, wallet);

         const redisKey = buildIdempotencyCacheKey(
            wallet.publicKey(),
            idempotencyKey
         );
         redisStore.set(redisKey, {
            value: JSON.stringify({ inProgress: true, startedAt: Date.now() }),
            expires: Date.now() + 60000,
            ttl: 60,
         });

         // Simulate first request resolving after 80ms
         setTimeout(() => {
            redisStore.set(redisKey, {
               value: JSON.stringify({
                  statusCode: 200,
                  body: {
                     success: true,
                     data: { transactionHash: 'tx-async-resolved' },
                  },
                  resolvedAt: new Date().toISOString(),
               }),
               expires: Date.now() + IDEMPOTENCY_TTL_SECONDS * 1000,
               ttl: IDEMPOTENCY_TTL_SECONDS,
            });
         }, 80);

         const res = await supertest(app)
            .post('/buy')
            .set(authHeaders)
            .set('Idempotency-Key', idempotencyKey)
            .send(body);

         expect(res.status).toBe(200);
         expect(res.headers['x-idempotent-replay']).toBe('true');
         expect(res.body.data.transactionHash).toBe('tx-async-resolved');
         expect(sorobanBuySubmit).not.toHaveBeenCalled();
      });
   });

   describe('Wallet Address Namespacing', () => {
      it('prevents cross-wallet collisions when different wallets use the same Idempotency-Key', async () => {
         const wallet1 = Keypair.random();
         const wallet2 = Keypair.random();
         const sharedKey = 'client-generated-uuid-1234';

         const body1 = { quantity: 1, key_cost_xlm: 10 };
         const body2 = { quantity: 2, key_cost_xlm: 20 };

         const res1 = await supertest(app)
            .post('/api/v1/creators/creator-1/buy')
            .set(buildAuthHeaders(body1, wallet1))
            .set('Idempotency-Key', sharedKey)
            .send(body1);

         const res2 = await supertest(app)
            .post('/api/v1/creators/creator-1/buy')
            .set(buildAuthHeaders(body2, wallet2))
            .set('Idempotency-Key', sharedKey)
            .send(body2);

         expect(res1.status).toBe(200);
         expect(res2.status).toBe(200);
         expect(sorobanBuySubmit).toHaveBeenCalledTimes(2);

         const key1 = buildIdempotencyCacheKey(wallet1.publicKey(), sharedKey);
         const key2 = buildIdempotencyCacheKey(wallet2.publicKey(), sharedKey);

         expect(key1).not.toBe(key2);
         expect(redisStore.has(key1)).toBe(true);
         expect(redisStore.has(key2)).toBe(true);

         expect(res1.body.data.quantity).toBe(1);
         expect(res2.body.data.quantity).toBe(2);
      });
   });

   describe('TTL Expiration and Re-Execution', () => {
      it('allows a fresh execution after key expires in Redis', async () => {
         const wallet = Keypair.random();
         const body = { quantity: 1, key_cost_xlm: 10 };
         const idempotencyKey = 'expiring-key-1';
         const authHeaders = buildAuthHeaders(body, wallet);

         // First execution
         const res1 = await supertest(app)
            .post('/api/v1/creators/creator-1/buy')
            .set(authHeaders)
            .set('Idempotency-Key', idempotencyKey)
            .send(body);

         expect(res1.status).toBe(200);
         expect(sorobanBuySubmit).toHaveBeenCalledTimes(1);

         // Simulate 24-hour TTL expiration by updating expiration in Redis
         const redisKey = buildIdempotencyCacheKey(
            wallet.publicKey(),
            idempotencyKey
         );
         const stored = redisStore.get(redisKey)!;
         redisStore.set(redisKey, {
            ...stored,
            expires: Date.now() - 1000, // Expired in the past
         });

         // Fresh execution with same key after expiration
         const res2 = await supertest(app)
            .post('/api/v1/creators/creator-1/buy')
            .set(authHeaders)
            .set('Idempotency-Key', idempotencyKey)
            .send(body);

         expect(res2.status).toBe(200);
         expect(res2.headers['x-idempotent-replay']).toBeUndefined();
         expect(sorobanBuySubmit).toHaveBeenCalledTimes(2);
      });
   });
});
