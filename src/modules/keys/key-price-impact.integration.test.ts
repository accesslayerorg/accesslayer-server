// src/modules/keys/key-price-impact.integration.test.ts
// Integration tests for GET /keys/:keyId/price-impact

const redisStore = new Map<string, unknown>();

jest.mock('../../utils/redis.utils', () => ({
   ...jest.requireActual('../../utils/redis.utils'),
   getRedis: () => null,
   getRedisClient: () => null,
   cacheGetJson: jest.fn(async (key: string) => redisStore.get(key) ?? null),
   cacheSetJson: jest.fn(async (key: string, value: unknown) => {
      redisStore.set(key, value);
   }),
   cacheInvalidate: jest.fn(),
}));

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      creatorProfile: { findFirst: jest.fn() },
      registeredKey: { findFirst: jest.fn() },
      protocolConfig: { findFirst: jest.fn(), upsert: jest.fn() },
      userTierVolume: { findFirst: jest.fn() },
      traderVolumeDiscountTier: { findMany: jest.fn() },
   },
}));

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
   },
}));

jest.setTimeout(60_000);

import supertest from 'supertest';
import { xdr, nativeToScVal } from '@stellar/stellar-base';
import app from '../../app';
import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';
import {
   setOnChainPriceImpactFetcher,
   callContractPriceImpact,
} from './key-price-impact.service';

const mockPrisma = prisma as unknown as {
   creatorProfile: { findFirst: jest.Mock };
   registeredKey: { findFirst: jest.Mock };
   protocolConfig: { findFirst: jest.Mock; upsert: jest.Mock };
};

const BASE_CREATOR = {
   id: 'creator-abc',
   handle: 'myhandle',
   circulatingSupply: 100,
   baseExponent: 1,
   curveMilestones: [],
   creatorRoyaltyBuyBps: 0,
   creatorRoyaltySellBps: 0,
};

describe('GET /keys/:keyId/price-impact', () => {
   beforeEach(() => {
      redisStore.clear();
      jest.clearAllMocks();
      setOnChainPriceImpactFetcher(null);
      mockPrisma.registeredKey.findFirst.mockResolvedValue(null);
      mockPrisma.protocolConfig.findFirst.mockResolvedValue({
         protocolFeeBps: 500,
      });
   });

   // ── Input Validation ──────────────────────────────────────────────────────────

   describe('Validation', () => {
      it('returns 400 when amount is missing', async () => {
         const res = await supertest(app).get(
            '/keys/creator-abc/price-impact?direction=buy'
         );
         expect(res.status).toBe(400);
         expect(res.body.success).toBe(false);
         expect(res.body.error.code).toBe('VALIDATION_ERROR');
      });

      it('returns 400 when direction is missing', async () => {
         const res = await supertest(app).get(
            '/keys/creator-abc/price-impact?amount=5'
         );
         expect(res.status).toBe(400);
         expect(res.body.success).toBe(false);
         expect(res.body.error.code).toBe('VALIDATION_ERROR');
      });

      it('returns 400 when amount is 0', async () => {
         const res = await supertest(app).get(
            '/keys/creator-abc/price-impact?amount=0&direction=buy'
         );
         expect(res.status).toBe(400);
         expect(res.body.success).toBe(false);
      });

      it('returns 400 when amount is negative', async () => {
         const res = await supertest(app).get(
            '/keys/creator-abc/price-impact?amount=-5&direction=buy'
         );
         expect(res.status).toBe(400);
         expect(res.body.success).toBe(false);
      });

      it('returns 400 when amount is non-numeric', async () => {
         const res = await supertest(app).get(
            '/keys/creator-abc/price-impact?amount=invalid&direction=buy'
         );
         expect(res.status).toBe(400);
         expect(res.body.success).toBe(false);
      });

      it('returns 400 when direction is invalid', async () => {
         const res = await supertest(app).get(
            '/keys/creator-abc/price-impact?amount=5&direction=swap'
         );
         expect(res.status).toBe(400);
         expect(res.body.success).toBe(false);
      });

      it('returns 400 when selling more keys than current supply', async () => {
         mockPrisma.creatorProfile.findFirst.mockResolvedValue({
            ...BASE_CREATOR,
            circulatingSupply: 3,
         });

         const res = await supertest(app).get(
            '/keys/creator-abc/price-impact?amount=10&direction=sell'
         );
         expect(res.status).toBe(400);
         expect(res.body.success).toBe(false);
         expect(res.body.error.message).toContain(
            'Cannot sell more keys than current supply'
         );
      });
   });

   // ── Unknown Key IDs (404) ─────────────────────────────────────────────────────

   describe('Key Not Found', () => {
      it('returns 404 for unknown key ID on /keys/:keyId/price-impact', async () => {
         mockPrisma.creatorProfile.findFirst.mockResolvedValue(null);
         mockPrisma.registeredKey.findFirst.mockResolvedValue(null);

         const res = await supertest(app).get(
            '/keys/unknown-key/price-impact?amount=1&direction=buy'
         );
         expect(res.status).toBe(404);
         expect(res.body.success).toBe(false);
         expect(res.body.error.code).toBe('NOT_FOUND');
      });

      it('returns 404 for unknown key ID on /api/v1/keys/:keyId/price-impact', async () => {
         mockPrisma.creatorProfile.findFirst.mockResolvedValue(null);
         mockPrisma.registeredKey.findFirst.mockResolvedValue(null);

         const res = await supertest(app).get(
            '/api/v1/keys/unknown-key/price-impact?amount=1&direction=buy'
         );
         expect(res.status).toBe(404);
         expect(res.body.success).toBe(false);
         expect(res.body.error.code).toBe('NOT_FOUND');
      });
   });

   // ── Calculation and Response Format ───────────────────────────────────────────

   describe('Calculation & Response Format', () => {
      it('returns correct price impact bps and amounts for buy direction', async () => {
         mockPrisma.creatorProfile.findFirst.mockResolvedValue(BASE_CREATOR);

         const res = await supertest(app).get(
            '/keys/creator-abc/price-impact?amount=5&direction=buy'
         );
         expect(res.status).toBe(200);
         expect(res.body.success).toBe(true);

         const data = res.body.data;
         expect(data).toHaveProperty('estimated_output');
         expect(data).toHaveProperty('price_impact_bps');
         expect(data).toHaveProperty('fee_amount');
         expect(data).toHaveProperty('net_received');

         // At supply 100, buyCost for qty 5 is 56_250_000
         // avg unit price = 11_250_000; spot = 11_000_000
         // impact = (11_250_000 - 11_000_000) / 11_000_000 * 10000 ≈ 227 bps
         expect(data.price_impact_bps).toBe(227);
         expect(data.estimated_output).toBe('56250000');

         // 500 bps (5%) fee = 56250000 * 500 / 10000 = 2812500
         expect(data.fee_amount).toBe('2812500');

         // net_received (total required) = 56250000 + 2812500 = 59062500
         expect(data.net_received).toBe('59062500');
      });

      it('returns correct price impact bps for qty 1 at supply 0 (500 bps)', async () => {
         mockPrisma.creatorProfile.findFirst.mockResolvedValue({
            ...BASE_CREATOR,
            circulatingSupply: 0,
         });

         const res = await supertest(app).get(
            '/keys/creator-abc/price-impact?amount=1&direction=buy'
         );
         expect(res.status).toBe(200);

         // buyCost(0, 1) = 1_050_000; spot = 1_000_000
         // impact = 50_000 / 1_000_000 * 10000 = 500 bps (5.00%)
         expect(res.body.data.price_impact_bps).toBe(500);
         expect(res.body.data.estimated_output).toBe('1050000');
      });

      it('returns correct price impact bps and amounts for sell direction', async () => {
         mockPrisma.creatorProfile.findFirst.mockResolvedValue(BASE_CREATOR);

         const res = await supertest(app).get(
            '/keys/creator-abc/price-impact?amount=5&direction=sell'
         );
         expect(res.status).toBe(200);
         expect(res.body.success).toBe(true);

         const data = res.body.data;
         // sellProceeds(100, 5) = 53_750_000
         // avg unit price = 10_750_000; spot = 11_000_000
         // impact = (11_000_000 - 10_750_000) / 11_000_000 * 10000 ≈ 227 bps
         expect(data.price_impact_bps).toBe(227);
         expect(data.estimated_output).toBe('53750000');

         // 500 bps (5%) fee = 53750000 * 500 / 10000 = 2687500
         expect(data.fee_amount).toBe('2687500');

         // net_received (proceeds - fee) = 53750000 - 2687500 = 51062500
         expect(data.net_received).toBe('51062500');
         expect(BigInt(data.net_received)).toBe(
            BigInt(data.estimated_output) - BigInt(data.fee_amount)
         );
      });

      it('resolves key by handle', async () => {
         mockPrisma.creatorProfile.findFirst.mockResolvedValue(BASE_CREATOR);

         const res = await supertest(app).get(
            '/keys/myhandle/price-impact?amount=5&direction=buy'
         );
         expect(res.status).toBe(200);
         expect(res.body.data.price_impact_bps).toBe(227);
      });

      it('works on /api/v1/keys/:keyId/price-impact path as well', async () => {
         mockPrisma.creatorProfile.findFirst.mockResolvedValue(BASE_CREATOR);

         const res = await supertest(app).get(
            '/api/v1/keys/creator-abc/price-impact?amount=5&direction=buy'
         );
         expect(res.status).toBe(200);
         expect(res.body.data.price_impact_bps).toBe(227);
      });
   });

   // ── No Caching (Always Live from RPC/State) ───────────────────────────────────

   describe('No Caching', () => {
      it('does not write to or read from Redis cache', async () => {
         mockPrisma.creatorProfile.findFirst.mockResolvedValue(BASE_CREATOR);

         await supertest(app).get(
            '/keys/creator-abc/price-impact?amount=5&direction=buy'
         );
         await supertest(app).get(
            '/keys/creator-abc/price-impact?amount=5&direction=buy'
         );

         // Cache should NOT be touched for live price impact preview
         expect(cacheGetJson).not.toHaveBeenCalled();
         expect(cacheSetJson).not.toHaveBeenCalled();

         // DB lookup should happen on every request
         expect(mockPrisma.creatorProfile.findFirst).toHaveBeenCalledTimes(2);
      });

      it('immediately reflects live state change on subsequent requests', async () => {
         mockPrisma.creatorProfile.findFirst.mockResolvedValue({
            ...BASE_CREATOR,
            circulatingSupply: 0,
         });

         const res1 = await supertest(app).get(
            '/keys/creator-abc/price-impact?amount=1&direction=buy'
         );
         expect(res1.body.data.price_impact_bps).toBe(500);

         // Supply increased to 100 on next block
         mockPrisma.creatorProfile.findFirst.mockResolvedValue({
            ...BASE_CREATOR,
            circulatingSupply: 100,
         });

         const res2 = await supertest(app).get(
            '/keys/creator-abc/price-impact?amount=1&direction=buy'
         );
         // At supply 100, buy 1 key has impact ~9 bps (100_000 / 11_000_000 * 10000)
         expect(res2.body.data.price_impact_bps).not.toBe(500);
      });
   });

   // ── Contract View Function (On-Chain Simulation) ──────────────────────────────

   describe('On-Chain Contract View Function', () => {
      it('returns on-chain view function result when custom fetcher is configured', async () => {
         mockPrisma.registeredKey.findFirst.mockResolvedValue({
            id: 'creator-abc',
            keyAddress:
               'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
            handle: 'myhandle',
         });
         mockPrisma.creatorProfile.findFirst.mockResolvedValue(BASE_CREATOR);

         setOnChainPriceImpactFetcher(
            async (_contractId, _amount, _direction) => {
               return {
                  estimated_output: '99000000',
                  price_impact_bps: 145,
                  fee_amount: '4950000',
                  net_received: '94050000',
               };
            }
         );

         const res = await supertest(app).get(
            '/keys/creator-abc/price-impact?amount=10&direction=buy'
         );
         expect(res.status).toBe(200);
         expect(res.body.data.estimated_output).toBe('99000000');
         expect(res.body.data.price_impact_bps).toBe(145);
         expect(res.body.data.fee_amount).toBe('4950000');
         expect(res.body.data.net_received).toBe('94050000');
      });

      it('callContractPriceImpact decodes on-chain ScVal map correctly', async () => {
         const contractId =
            'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

         const mapScVal = xdr.ScVal.scvMap([
            new xdr.ScMapEntry({
               key: xdr.ScVal.scvSymbol('estimated_output'),
               val: nativeToScVal(50000000n),
            }),
            new xdr.ScMapEntry({
               key: xdr.ScVal.scvSymbol('price_impact_bps'),
               val: xdr.ScVal.scvU32(180),
            }),
            new xdr.ScMapEntry({
               key: xdr.ScVal.scvSymbol('fee_amount'),
               val: nativeToScVal(2500000n),
            }),
            new xdr.ScMapEntry({
               key: xdr.ScVal.scvSymbol('net_received'),
               val: nativeToScVal(47500000n),
            }),
         ]);
         const mapXdr = mapScVal.toXDR('base64');

         const mockPostJson = jest.fn().mockResolvedValue({
            jsonrpc: '2.0',
            id: 'get-price-impact',
            result: {
               results: [{ retval: mapXdr }],
            },
         });

         const result = await callContractPriceImpact(
            contractId,
            5,
            'sell',
            mockPostJson
         );
         expect(result).not.toBeNull();
         expect(result!.estimated_output).toBe('50000000');
         expect(result!.price_impact_bps).toBe(180);
         expect(result!.fee_amount).toBe('2500000');
         expect(result!.net_received).toBe('47500000');
      });

      it('callContractPriceImpact decodes on-chain ScVal vec correctly', async () => {
         const contractId =
            'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

         const vecScVal = xdr.ScVal.scvVec([
            nativeToScVal(60000000n),
            xdr.ScVal.scvU32(210),
            nativeToScVal(3000000n),
            nativeToScVal(57000000n),
         ]);
         const vecXdr = vecScVal.toXDR('base64');

         const mockPostJson = jest.fn().mockResolvedValue({
            jsonrpc: '2.0',
            id: 'get-price-impact',
            result: {
               results: [{ retval: vecXdr }],
            },
         });

         const result = await callContractPriceImpact(
            contractId,
            5,
            'sell',
            mockPostJson
         );
         expect(result).not.toBeNull();
         expect(result!.estimated_output).toBe('60000000');
         expect(result!.price_impact_bps).toBe(210);
         expect(result!.fee_amount).toBe('3000000');
         expect(result!.net_received).toBe('57000000');
      });
   });

   // ── Latency SLA ───────────────────────────────────────────────────────────────

   describe('Latency', () => {
      it('responds in under 300ms under normal load', async () => {
         mockPrisma.creatorProfile.findFirst.mockResolvedValue(BASE_CREATOR);

         const start = Date.now();
         const res = await supertest(app).get(
            '/keys/creator-abc/price-impact?amount=5&direction=buy'
         );
         const duration = Date.now() - start;

         expect(res.status).toBe(200);
         expect(duration).toBeLessThan(300);
      });
   });
});
