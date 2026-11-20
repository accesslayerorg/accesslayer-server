import express from 'express';
import supertest from 'supertest';
import { Keypair } from '@stellar/stellar-base';
import { buildAuthHeaders } from '../../utils/test/auth-request.utils';
import { requireStellarSignature } from '../../middlewares/stellar-signature.middleware';
import { requireTradeNonce } from './nonce.middleware';
import nonceRouter from './nonce.routes';
import {
   generateTradeNonce,
   verifyAndConsumeTradeNonce,
   resetTradeNonceStateForTests,
   getTradeNonceTTL,
} from './nonce.service';

describe('Key Nonce-Based Replay Protection for Signed Trade Messages (#1194)', () => {
   const wallet = Keypair.random();
   const walletAddress = wallet.publicKey();
   const anotherWallet = Keypair.random();
   const anotherWalletAddress = anotherWallet.publicKey();

   let app: express.Express;

   beforeEach(() => {
      resetTradeNonceStateForTests();
      jest.clearAllMocks();

      app = express();
      app.use(express.json());
      app.use('/nonce', nonceRouter);
      app.use('/api/v1/nonce', nonceRouter);

      // Buy endpoint mock
      app.post(
         '/api/v1/creators/:id/buy',
         requireStellarSignature({ tradeNonce: true }),
         requireTradeNonce(),
         (req, res) => {
            res.status(200).json({ success: true, message: 'Buy executed', data: req.body });
         }
      );

      // Sell endpoint mock
      app.post(
         '/api/v1/creators/:id/sell',
         requireStellarSignature({ tradeNonce: true }),
         requireTradeNonce(),
         (req, res) => {
            res.status(200).json({ success: true, message: 'Sell executed', data: req.body });
         }
      );

      // Transfer endpoint mock
      app.post(
         '/api/v1/creators/:id/transfer',
         requireStellarSignature({ tradeNonce: true }),
         requireTradeNonce(),
         (req, res) => {
            res.status(200).json({ success: true, message: 'Transfer executed', data: req.body });
         }
      );
   });

   describe('GET /nonce/:wallet', () => {
      it('returns a fresh one-time nonce with configured TTL (default 300s)', async () => {
         const res = await supertest(app).get(`/nonce/${walletAddress}`);

         expect(res.status).toBe(200);
         expect(res.body.success).toBe(true);
         expect(res.body.data.wallet).toBe(walletAddress);
         expect(typeof res.body.data.nonce).toBe('string');
         expect(res.body.data.nonce.length).toBeGreaterThan(0);
         expect(res.body.data.ttl).toBe(300);

         // Second call returns a fresh unique nonce
         const res2 = await supertest(app).get(`/nonce/${walletAddress}`);
         expect(res2.status).toBe(200);
         expect(res2.body.data.nonce).not.toBe(res.body.data.nonce);
      });

      it('works via /api/v1/nonce/:wallet route prefix', async () => {
         const res = await supertest(app).get(`/api/v1/nonce/${walletAddress}`);

         expect(res.status).toBe(200);
         expect(res.body.success).toBe(true);
         expect(res.body.data.wallet).toBe(walletAddress);
         expect(typeof res.body.data.nonce).toBe('string');
      });

      it('rejects invalid Stellar address with 400 validation error', async () => {
         const res = await supertest(app).get('/nonce/invalid-stellar-address');

         expect(res.status).toBe(400);
         expect(res.body.success).toBe(false);
         expect(res.body.error.code).toBe('VALIDATION_ERROR');
      });
   });

   describe('Service: generateTradeNonce & verifyAndConsumeTradeNonce', () => {
      it('first use of valid nonce succeeds and deletes nonce atomically', async () => {
         const nonce = await generateTradeNonce(walletAddress);
         expect(typeof nonce).toBe('string');

         const firstUse = await verifyAndConsumeTradeNonce(walletAddress, nonce);
         expect(firstUse).toBe(true);

         // Reuse must return false
         const secondUse = await verifyAndConsumeTradeNonce(walletAddress, nonce);
         expect(secondUse).toBe(false);
      });

      it('rejects non-existent nonce', async () => {
         const result = await verifyAndConsumeTradeNonce(walletAddress, 'non-existent-nonce-xyz');
         expect(result).toBe(false);
      });

      it('rejects nonce when wallet does not match', async () => {
         const nonce = await generateTradeNonce(walletAddress);
         const result = await verifyAndConsumeTradeNonce(anotherWalletAddress, nonce);
         expect(result).toBe(false);
      });

      it('returns configurable TTL from environment', () => {
         expect(getTradeNonceTTL()).toBe(300);
      });
   });

   describe('Trade Endpoints: Buy endpoint nonce replay protection', () => {
      it('succeeds with valid nonce in signed payload and deletes nonce atomically', async () => {
         // 1. Fetch nonce
         const nonceRes = await supertest(app).get(`/nonce/${walletAddress}`);
         const nonce = nonceRes.body.data.nonce;

         // 2. Submit signed buy request with nonce in payload
         const body = { quantity: 10, key_cost_xlm: 100, nonce };
         const headers = buildAuthHeaders(body, wallet);

         const buyRes = await supertest(app)
            .post('/api/v1/creators/creator-1/buy')
            .set(headers)
            .send(body);

         expect(buyRes.status).toBe(200);
         expect(buyRes.body.success).toBe(true);
         expect(buyRes.body.data.nonce).toBe(nonce);

         // 3. Replaying the exact same signed payload returns 401 nonce_invalid
         const replayRes = await supertest(app)
            .post('/api/v1/creators/creator-1/buy')
            .set(headers)
            .send(body);

         expect(replayRes.status).toBe(401);
         expect(replayRes.body.error.code).toBe('nonce_invalid');
      });

      it('rejects buy request missing nonce with 401 nonce_invalid', async () => {
         const body = { quantity: 10, key_cost_xlm: 100 };
         const headers = buildAuthHeaders(body, wallet);

         const res = await supertest(app)
            .post('/api/v1/creators/creator-1/buy')
            .set(headers)
            .send(body);

         expect(res.status).toBe(401);
         expect(res.body.error.code).toBe('nonce_invalid');
      });

      it('rejects buy request with fake or expired nonce with 401 nonce_invalid', async () => {
         const body = { quantity: 10, key_cost_xlm: 100, nonce: 'expired-or-fake-nonce-123' };
         const headers = buildAuthHeaders(body, wallet);

         const res = await supertest(app)
            .post('/api/v1/creators/creator-1/buy')
            .set(headers)
            .send(body);

         expect(res.status).toBe(401);
         expect(res.body.error.code).toBe('nonce_invalid');
      });
   });

   describe('Trade Endpoints: Sell endpoint nonce replay protection', () => {
      it('succeeds with valid nonce in signed payload and prevents replay', async () => {
         const nonceRes = await supertest(app).get(`/nonce/${walletAddress}`);
         const nonce = nonceRes.body.data.nonce;

         const body = { quantity: 5, min_price: 10, nonce };
         const headers = buildAuthHeaders(body, wallet);

         const sellRes = await supertest(app)
            .post('/api/v1/creators/creator-1/sell')
            .set(headers)
            .send(body);

         expect(sellRes.status).toBe(200);
         expect(sellRes.body.success).toBe(true);

         // Second use returns 401 nonce_invalid
         const replayRes = await supertest(app)
            .post('/api/v1/creators/creator-1/sell')
            .set(headers)
            .send(body);

         expect(replayRes.status).toBe(401);
         expect(replayRes.body.error.code).toBe('nonce_invalid');
      });

      it('rejects sell request missing nonce with 401 nonce_invalid', async () => {
         const body = { quantity: 5, min_price: 10 };
         const headers = buildAuthHeaders(body, wallet);

         const res = await supertest(app)
            .post('/api/v1/creators/creator-1/sell')
            .set(headers)
            .send(body);

         expect(res.status).toBe(401);
         expect(res.body.error.code).toBe('nonce_invalid');
      });
   });

   describe('Trade Endpoints: Transfer endpoint nonce replay protection', () => {
      it('succeeds with valid nonce in signed payload and prevents replay', async () => {
         const nonceRes = await supertest(app).get(`/nonce/${walletAddress}`);
         const nonce = nonceRes.body.data.nonce;

         const body = {
            toAddress: anotherWalletAddress,
            quantity: 3,
            nonce,
         };
         const headers = buildAuthHeaders(body, wallet);

         const transferRes = await supertest(app)
            .post('/api/v1/creators/creator-1/transfer')
            .set(headers)
            .send(body);

         expect(transferRes.status).toBe(200);
         expect(transferRes.body.success).toBe(true);

         // Second use returns 401 nonce_invalid
         const replayRes = await supertest(app)
            .post('/api/v1/creators/creator-1/transfer')
            .set(headers)
            .send(body);

         expect(replayRes.status).toBe(401);
         expect(replayRes.body.error.code).toBe('nonce_invalid');
      });

      it('rejects transfer request missing nonce with 401 nonce_invalid', async () => {
         const body = {
            toAddress: anotherWalletAddress,
            quantity: 3,
         };
         const headers = buildAuthHeaders(body, wallet);

         const res = await supertest(app)
            .post('/api/v1/creators/creator-1/transfer')
            .set(headers)
            .send(body);

         expect(res.status).toBe(401);
         expect(res.body.error.code).toBe('nonce_invalid');
      });
   });

   describe('Redis Atomic Operations & TTL Simulation', () => {
      it('stores nonce with TTL in Redis and deletes atomically on first use', async () => {
         const mockRedisStore = new Map<string, string>();
         const mockMulti: any = {};
         mockMulti.set = jest.fn((k: string, v: string) => {
            mockRedisStore.set(k, v);
            return mockMulti;
         });
         mockMulti.exec = jest.fn().mockResolvedValue([]);

         const mockClient = {
            status: 'ready',
            multi: jest.fn(() => mockMulti),
            eval: jest.fn(async (_script: string, _numkeys: number, key1: string, key2: string, arg1: string) => {
               const val1 = mockRedisStore.get(key1);
               const val2 = mockRedisStore.get(key2);
               if (val1 === arg1 || val2 === arg1 || val2 === '1') {
                  mockRedisStore.delete(key1);
                  mockRedisStore.delete(key2);
                  return 1;
               }
               return 0;
            }),
         };

         const redisModule = require('../../utils/redis.utils');
         const spy = jest.spyOn(redisModule, 'getRedisClient').mockReturnValue(mockClient as any);

         // 1. Generate nonce
         const nonce = await generateTradeNonce(walletAddress);
         expect(mockMulti.set).toHaveBeenCalledWith(`nonce:${walletAddress}`, nonce, 'EX', 300);
         expect(mockMulti.set).toHaveBeenCalledWith(`nonce:${walletAddress}:${nonce}`, nonce, 'EX', 300);

         // 2. First verification: matches and deletes
         const first = await verifyAndConsumeTradeNonce(walletAddress, nonce);
         expect(first).toBe(true);
         expect(mockClient.eval).toHaveBeenCalledTimes(1);
         expect(mockRedisStore.has(`nonce:${walletAddress}`)).toBe(false);

         // 3. Second verification: already deleted -> returns false
         const second = await verifyAndConsumeTradeNonce(walletAddress, nonce);
         expect(second).toBe(false);

         spy.mockRestore();
      });

      it('expired nonce in Redis returns false and is rejected', async () => {
         const mockClient = {
            status: 'ready',
            multi: jest.fn(() => ({
               set: jest.fn().mockReturnThis(),
               exec: jest.fn().mockResolvedValue([]),
            })),
            eval: jest.fn().mockResolvedValue(0), // Redis expired the key
         };

         const redisModule = require('../../utils/redis.utils');
         const spy = jest.spyOn(redisModule, 'getRedisClient').mockReturnValue(mockClient as any);

         const result = await verifyAndConsumeTradeNonce(walletAddress, 'expired-nonce-token');
         expect(result).toBe(false);

         spy.mockRestore();
      });
   });
});
