// src/modules/trading/nonce.integration.test.ts
// Integration tests for key nonce-based replay protection for signed trade messages (#1194).

import express from 'express';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-base';
import { requireStellarSignature } from '../../middlewares/stellar-signature.middleware';
import { enforceTradeNonce } from '../../middlewares/trade-nonce.middleware';
import { validateBody } from '../../middlewares/validate-body.middleware';
import { buildAuthHeaders } from '../../utils/test/auth-request.utils';
import { httpBuyCreatorKey, buySchema } from '../creator/buy.controller';
import { httpSellCreatorKey, sellSchema } from '../creator/sell.controller';
import { httpTransferCreatorKey, transferSchema } from '../creator/transfer.controller';
import { buyGateway } from '../creator/buy.service';
import nonceRouter from './nonce.routes';
import { issueNonce, consumeNonce, getNonceRedisKey, getWalletNonceRedisKey } from './nonce.service';
import { prisma } from '../../utils/prisma.utils';
import * as keyTradingService from '../keys/key-trading.service';
import * as keyFreezeService from '../keys/key-freeze.service';
import * as flashLoanService from '../indexer/flash-loan-guard-indexer.service';
import * as keyFeesService from '../keys/key-fees.service';
import * as keyCooldownService from '../keys/key-cooldown.service';
import * as keyTransferService from '../keys/key-transfer.service';
import * as pricingUtils from '../../utils/pricing.utils';
import * as holdingSnapshotService from '../portfolio/holding-snapshot.service';
import * as leaderboardService from '../keys/key-holder-leaderboard.service';
import * as holdingsController from '../users/holdings.controller';
import * as creatorDashboardService from '../creator/creator-dashboard.service';
import * as liquidityDepthService from './liquidity-depth.service';

// Mock Redis in-memory store for predictable unit/integration testing
const redisMap = new Map<string, { value: string; expiresAt: number }>();

jest.mock('../../utils/redis.utils', () => {
   const original = jest.requireActual('../../utils/redis.utils');
   const mockClient = {
      set: jest.fn(async (key: string, value: string, _mode?: string, ttl?: number) => {
         const expiresAt = ttl ? Date.now() + ttl * 1000 : Infinity;
         redisMap.set(key, { value: String(value), expiresAt });
         return 'OK';
      }),
      get: jest.fn(async (key: string) => {
         const entry = redisMap.get(key);
         if (!entry) return null;
         if (Date.now() > entry.expiresAt) {
            redisMap.delete(key);
            return null;
         }
         return entry.value;
      }),
      del: jest.fn(async (...keys: string[]) => {
         let count = 0;
         for (const k of keys) {
            if (redisMap.has(k)) {
               const entry = redisMap.get(k)!;
               if (Date.now() <= entry.expiresAt) {
                  count++;
               }
               redisMap.delete(k);
            }
         }
         return count;
      }),
      eval: jest.fn(async (_script: string, numKeys: number, ...args: string[]) => {
         const keys = args.slice(0, numKeys);
         const argv = args.slice(numKeys);
         const walletKey = keys[0];
         const exactKey = keys[1];
         const expectedNonce = argv[0];

         let exactDel = 0;
         if (redisMap.has(exactKey)) {
            const entry = redisMap.get(exactKey)!;
            if (Date.now() <= entry.expiresAt) {
               exactDel = 1;
            }
            redisMap.delete(exactKey);
         }

         let walletVal: string | null = null;
         if (redisMap.has(walletKey)) {
            const entry = redisMap.get(walletKey)!;
            if (Date.now() <= entry.expiresAt) {
               walletVal = entry.value;
            } else {
               redisMap.delete(walletKey);
            }
         }

         if (exactDel === 1) {
            if (walletVal === expectedNonce) {
               redisMap.delete(walletKey);
            }
            return 1;
         } else if (walletVal === expectedNonce) {
            redisMap.delete(walletKey);
            return 1;
         } else {
            return 0;
         }
      }),
   };

   return {
      ...original,
      getRedis: () => mockClient,
      getRedisClient: () => mockClient,
   };
});

describe('Issue #1194 — Nonce-based replay protection for signed trade messages', () => {
   let app: express.Express;
   const creatorId = 'creator-test-1';

   beforeAll(() => {
      app = express();
      app.use(express.json());

      // Mount nonce endpoint at root and /api/v1
      app.use('/nonce', nonceRouter);
      app.use('/api/v1/nonce', nonceRouter);

      // Mount signed trade endpoints
      app.post(
         '/api/v1/creators/:id/buy',
         requireStellarSignature(),
         enforceTradeNonce(),
         validateBody(buySchema),
         httpBuyCreatorKey
      );

      app.post(
         '/api/v1/creators/:id/sell',
         requireStellarSignature(),
         enforceTradeNonce(),
         validateBody(sellSchema),
         httpSellCreatorKey
      );

      app.post(
         '/api/v1/creators/:id/transfer',
         requireStellarSignature(),
         enforceTradeNonce(),
         validateBody(transferSchema),
         httpTransferCreatorKey
      );

      app.post(
         '/api/v1/keys/:keyId/transfer',
         requireStellarSignature(),
         enforceTradeNonce(),
         validateBody(transferSchema),
         httpTransferCreatorKey
      );
   });

   beforeEach(() => {
      redisMap.clear();
      jest.clearAllMocks();

      // Default service mocks for clean trade passes
      jest.spyOn(keyTradingService, 'assertTradingActive').mockResolvedValue();
      jest.spyOn(keyFreezeService, 'assertPositionNotFrozen').mockResolvedValue();
      jest.spyOn(flashLoanService, 'assertWalletNotSuspended').mockResolvedValue();
      jest.spyOn(keyCooldownService, 'setBuyCooldownForWallet').mockResolvedValue('ok');
      jest.spyOn(keyFeesService, 'getKeyFees').mockResolvedValue({
         protocolFeeBps: 100,
         creatorRoyaltyBps: 200,
         totalFeeBps: 300,
      } as any);
      jest.spyOn(liquidityDepthService, 'getMaxAvailableDepth').mockResolvedValue(1000n);

      jest.spyOn(prisma.creatorProfile, 'findUnique').mockResolvedValue({
         id: creatorId,
         circulatingSupply: 10,
      } as any);
      jest.spyOn(prisma.creatorProfile, 'findFirst').mockResolvedValue({
         id: creatorId,
         handle: 'testcreator',
      } as any);
   });

   describe('1. GET /nonce/:wallet issuance and TTL', () => {
      it('returns a fresh one-time nonce stored in Redis with correct TTL', async () => {
         const wallet = Keypair.random().publicKey();

         const res = await request(app).get(`/nonce/${wallet}`);
         expect(res.status).toBe(200);
         expect(res.body.success).toBe(true);
         expect(res.body.data.nonce).toBeDefined();
         expect(res.body.data.expires_in).toBe(300);
         expect(res.body.nonce).toBe(res.body.data.nonce);

         const nonce = res.body.data.nonce;
         const exactKey = getNonceRedisKey(wallet, nonce);
         const walletKey = getWalletNonceRedisKey(wallet);

         expect(redisMap.has(exactKey)).toBe(true);
         expect(redisMap.has(walletKey)).toBe(true);
         expect(redisMap.get(walletKey)?.value).toBe(nonce);
      });

      it('also works when requested from /api/v1/nonce/:wallet', async () => {
         const wallet = Keypair.random().publicKey();

         const res = await request(app).get(`/api/v1/nonce/${wallet}`);
         expect(res.status).toBe(200);
         expect(res.body.data.nonce).toBeDefined();
      });

      it('rejects an invalid Stellar wallet address format with 400', async () => {
         const res = await request(app).get('/nonce/not-a-stellar-address');
         expect(res.status).toBe(400);
         expect(res.body.success).toBe(false);
         expect(res.body.error.code).toBe('BAD_REQUEST');
      });
   });

   describe('2. Direct nonce consumption and TTL expiry', () => {
      it('validates and deletes nonce atomically on first use, fails on second use', async () => {
         const wallet = Keypair.random().publicKey();
         const { nonce } = await issueNonce(wallet);

         // First consume succeeds
         const firstUse = await consumeNonce(wallet, nonce);
         expect(firstUse).toBe(true);

         // Second consume fails (already consumed)
         const secondUse = await consumeNonce(wallet, nonce);
         expect(secondUse).toBe(false);
      });

      it('rejects an expired nonce after TTL', async () => {
         const wallet = Keypair.random().publicKey();
         // Issue with 1 second TTL
         const { nonce } = await issueNonce(wallet, 1);

         // Simulate expiration
         const exactKey = getNonceRedisKey(wallet, nonce);
         const walletKey = getWalletNonceRedisKey(wallet);
         if (redisMap.has(exactKey)) {
            redisMap.get(exactKey)!.expiresAt = Date.now() - 1000;
         }
         if (redisMap.has(walletKey)) {
            redisMap.get(walletKey)!.expiresAt = Date.now() - 1000;
         }

         const consumed = await consumeNonce(wallet, nonce);
         expect(consumed).toBe(false);
      });

      it('rejects a nonce issued to wallet A when consumed by wallet B', async () => {
         const walletA = Keypair.random().publicKey();
         const walletB = Keypair.random().publicKey();
         const { nonce } = await issueNonce(walletA);

         const consumedByB = await consumeNonce(walletB, nonce);
         expect(consumedByB).toBe(false);
      });
   });

   describe('3. Signed trade endpoints replay protection', () => {
      it('POST /creators/:id/buy enforces nonce: first use succeeds, replay rejected with 401 nonce_invalid', async () => {
         const buyer = Keypair.random();
         const walletAddress = buyer.publicKey();

         // 1. Get nonce
         const nonceRes = await request(app).get(`/nonce/${walletAddress}`);
         const nonce = nonceRes.body.data.nonce;

         // Mock buy gateway balance and submission
         jest.spyOn(buyGateway, 'getXlmBalance').mockResolvedValue(100);
         jest.spyOn(buyGateway, 'submitBuy').mockResolvedValue({
            transactionHash: 'tx-buy-1',
         } as any);

         const body = {
            quantity: 1,
            key_cost_xlm: 10,
            fee_xlm: 1,
            nonce,
         };

         // First request: valid signature + valid nonce -> 200
         const authHeaders = buildAuthHeaders(body, buyer);
         const res1 = await request(app)
            .post(`/api/v1/creators/${creatorId}/buy`)
            .set(authHeaders)
            .send(body);

         expect(res1.status).toBe(200);
         expect(res1.body.data.transactionHash).toBe('tx-buy-1');

         // Replay attack: send exact same signed request with same nonce
         const resReplay = await request(app)
            .post(`/api/v1/creators/${creatorId}/buy`)
            .set(authHeaders)
            .send(body);

         expect(resReplay.status).toBe(401);
         expect(resReplay.body.success).toBe(false);
         expect(resReplay.body.error.code).toBe('nonce_invalid');
      });

      it('POST /creators/:id/sell enforces nonce: first use succeeds, replay rejected with 401 nonce_invalid', async () => {
         const seller = Keypair.random();
         const walletAddress = seller.publicKey();

         // 1. Get nonce
         const nonceRes = await request(app).get(`/nonce/${walletAddress}`);
         const nonce = nonceRes.body.data.nonce;

         // Mock sell execution dependencies
         jest.spyOn(pricingUtils, 'getSellUnitPrice').mockReturnValue(10_000_000n);
         jest.spyOn(pricingUtils, 'computeSellPayout').mockReturnValue(9_700_000n);
         jest.spyOn(holdingSnapshotService, 'recordHoldingSnapshot').mockResolvedValue();
         jest.spyOn(leaderboardService, 'onHolderBalanceChanged').mockResolvedValue();
         jest.spyOn(holdingsController, 'invalidateHoldingsCache').mockResolvedValue();
         jest.spyOn(creatorDashboardService, 'invalidateCreatorDashboardCache').mockResolvedValue();

         jest.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => {
            const mockTx = {
               creatorProfile: {
                  findUnique: jest.fn().mockResolvedValue({ id: creatorId, circulatingSupply: 10 }),
                  update: jest.fn().mockResolvedValue({}),
               },
               keyOwnership: {
                  findUnique: jest.fn().mockResolvedValue({ balance: 5, costBasis: 10, realisedPnl: 0 }),
                  update: jest.fn().mockResolvedValue({}),
               },
               activity: { create: jest.fn().mockResolvedValue({}) },
               activityLog: { create: jest.fn().mockResolvedValue({}) },
            };
            return callback(mockTx);
         });

         const body = {
            quantity: 1,
            min_price: 0.5,
            fee_xlm: 0,
            nonce,
         };

         // First request: valid signature + valid nonce -> 200
         const authHeaders = buildAuthHeaders(body, seller);
         const res1 = await request(app)
            .post(`/api/v1/creators/${creatorId}/sell`)
            .set(authHeaders)
            .send(body);

         expect(res1.status).toBe(200);

         // Replay attack: send exact same request again
         const resReplay = await request(app)
            .post(`/api/v1/creators/${creatorId}/sell`)
            .set(authHeaders)
            .send(body);

         expect(resReplay.status).toBe(401);
         expect(resReplay.body.success).toBe(false);
         expect(resReplay.body.error.code).toBe('nonce_invalid');
      });

      it('POST /creators/:id/transfer enforces nonce: first use succeeds, replay rejected with 401 nonce_invalid', async () => {
         const sender = Keypair.random();
         const recipient = Keypair.random();
         const walletAddress = sender.publicKey();

         // 1. Get nonce
         const nonceRes = await request(app).get(`/nonce/${walletAddress}`);
         const nonce = nonceRes.body.data.nonce;

         // Mock transfer service
         jest.spyOn(keyTransferService, 'transferKeys').mockResolvedValue({
            from: walletAddress,
            to: recipient.publicKey(),
            quantity: 1,
            newBalance: 1,
         } as any);

         const body = {
            toAddress: recipient.publicKey(),
            quantity: 1,
            nonce,
         };

         // First request: valid signature + valid nonce -> 200
         const authHeaders = buildAuthHeaders(body, sender);
         const res1 = await request(app)
            .post(`/api/v1/creators/${creatorId}/transfer`)
            .set(authHeaders)
            .send(body);

         expect(res1.status).toBe(200);
         expect(res1.body.data.quantity).toBe(1);

         // Replay attack: send exact same request again
         const resReplay = await request(app)
            .post(`/api/v1/creators/${creatorId}/transfer`)
            .set(authHeaders)
            .send(body);

         expect(resReplay.status).toBe(401);
         expect(resReplay.body.success).toBe(false);
         expect(resReplay.body.error.code).toBe('nonce_invalid');
      });

      it('POST /keys/:keyId/transfer also enforces nonce replay protection', async () => {
         const sender = Keypair.random();
         const recipient = Keypair.random();
         const walletAddress = sender.publicKey();

         const nonceRes = await request(app).get(`/nonce/${walletAddress}`);
         const nonce = nonceRes.body.data.nonce;

         jest.spyOn(keyTransferService, 'transferKeys').mockResolvedValue({
            from: walletAddress,
            to: recipient.publicKey(),
            quantity: 2,
            newBalance: 3,
         } as any);

         const body = {
            toAddress: recipient.publicKey(),
            quantity: 2,
            nonce,
         };

         const authHeaders = buildAuthHeaders(body, sender);
         const res1 = await request(app)
            .post(`/api/v1/keys/${creatorId}/transfer`)
            .set(authHeaders)
            .send(body);

         expect(res1.status).toBe(200);

         const resReplay = await request(app)
            .post(`/api/v1/keys/${creatorId}/transfer`)
            .set(authHeaders)
            .send(body);

         expect(resReplay.status).toBe(401);
         expect(resReplay.body.error.code).toBe('nonce_invalid');
      });

      it('rejects trade requests with missing nonce or empty string with 401 nonce_invalid', async () => {
         const buyer = Keypair.random();
         const bodyWithoutNonce = {
            quantity: 1,
            key_cost_xlm: 10,
            fee_xlm: 1,
         };

         const authHeaders = buildAuthHeaders(bodyWithoutNonce, buyer);
         const res = await request(app)
            .post(`/api/v1/creators/${creatorId}/buy`)
            .set(authHeaders)
            .send(bodyWithoutNonce);

         expect(res.status).toBe(401);
         expect(res.body.error.code).toBe('nonce_invalid');
      });
   });
});
