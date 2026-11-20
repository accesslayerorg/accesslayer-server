// Integration test: GET /api/v1/keys/:keyId/price

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
import app from '../../app';
import { prisma } from '../../utils/prisma.utils';
import { cacheSetJson } from '../../utils/redis.utils';

const mockPrisma = prisma as unknown as {
   creatorProfile: { findFirst: jest.Mock };
};

const BASE_CREATOR = {
   id: 'creator-abc',
   handle: 'myhandle',
   circulatingSupply: 100,
   baseExponent: 1,
   curveMilestones: [],
};

describe('GET /api/v1/keys/:keyId/price', () => {
   beforeEach(() => {
      redisStore.clear();
      jest.clearAllMocks();
   });

   // ── Validation ──────────────────────────────────────────────────────────

   it('returns 400 when quantity is 0', async () => {
      const res = await supertest(app).get('/api/v1/keys/creator-abc/price?quantity=0');
      expect(res.status).toBe(400);
   });

   it('returns 400 when quantity is negative', async () => {
      const res = await supertest(app).get('/api/v1/keys/creator-abc/price?quantity=-1');
      expect(res.status).toBe(400);
   });

   it('returns 400 when quantity exceeds 1_000_000', async () => {
      const res = await supertest(app).get('/api/v1/keys/creator-abc/price?quantity=1000001');
      expect(res.status).toBe(400);
   });

   it('returns 400 when quantity is not an integer', async () => {
      const res = await supertest(app).get('/api/v1/keys/creator-abc/price?quantity=1.5');
      expect(res.status).toBe(400);
   });

   it('returns 400 when quantity is non-numeric', async () => {
      const res = await supertest(app).get('/api/v1/keys/creator-abc/price?quantity=abc');
      expect(res.status).toBe(400);
   });

   // ── Not found ───────────────────────────────────────────────────────────

   it('returns 404 when key does not exist', async () => {
      mockPrisma.creatorProfile.findFirst.mockResolvedValue(null);
      const res = await supertest(app).get('/api/v1/keys/nonexistent/price');
      expect(res.status).toBe(404);
   });

   // ── Happy path ──────────────────────────────────────────────────────────

   it('returns 200 with correct shape for default quantity 1', async () => {
      mockPrisma.creatorProfile.findFirst.mockResolvedValue(BASE_CREATOR);

      const res = await supertest(app).get('/api/v1/keys/creator-abc/price');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const data = res.body.data;
      expect(data.keyId).toBe('creator-abc');
      expect(data.quantity).toBe(1);
      expect(data.currentSupply).toBe('100');
      expect(typeof data.buy.unitPrice).toBe('string');
      expect(typeof data.buy.totalCost).toBe('string');
      expect(typeof data.priceImpactPercent).toBe('string');
      // Supply is 100, selling 1 is possible
      expect(data.sell).not.toBeNull();
      expect(typeof data.sell.unitPrice).toBe('string');
      expect(typeof data.sell.totalProceeds).toBe('string');
   });

   it('resolves key by handle', async () => {
      mockPrisma.creatorProfile.findFirst.mockResolvedValue(BASE_CREATOR);

      const res = await supertest(app).get('/api/v1/keys/myhandle/price?quantity=5');
      expect(res.status).toBe(200);
      expect(res.body.data.keyId).toBe('creator-abc');
      expect(res.body.data.quantity).toBe(5);
   });

   it('returns null sell when quantity > supply', async () => {
      mockPrisma.creatorProfile.findFirst.mockResolvedValue({
         ...BASE_CREATOR,
         circulatingSupply: 3,
      });

      const res = await supertest(app).get('/api/v1/keys/creator-abc/price?quantity=10');
      expect(res.status).toBe(200);
      expect(res.body.data.sell).toBeNull();
   });

   it('buy.totalCost equals buy.unitPrice * quantity for qty 1', async () => {
      mockPrisma.creatorProfile.findFirst.mockResolvedValue(BASE_CREATOR);

      const res = await supertest(app).get('/api/v1/keys/creator-abc/price?quantity=1');
      expect(res.status).toBe(200);
      const { unitPrice, totalCost } = res.body.data.buy;
      // For qty=1, totalCost / 1 = unitPrice
      expect(BigInt(unitPrice)).toBe(BigInt(totalCost));
   });

   it('buy totalCost is positive (greater than 0)', async () => {
      mockPrisma.creatorProfile.findFirst.mockResolvedValue(BASE_CREATOR);

      const res = await supertest(app).get('/api/v1/keys/creator-abc/price?quantity=5');
      expect(res.status).toBe(200);
      expect(BigInt(res.body.data.buy.totalCost)).toBeGreaterThan(0n);
   });

   it('accepts quantity = 1_000_000 (max boundary)', async () => {
      mockPrisma.creatorProfile.findFirst.mockResolvedValue(BASE_CREATOR);

      const res = await supertest(app).get('/api/v1/keys/creator-abc/price?quantity=1000000');
      expect(res.status).toBe(200);
   });

   // ── Redis caching ───────────────────────────────────────────────────────

   it('serves subsequent requests from cache (DB called once)', async () => {
      mockPrisma.creatorProfile.findFirst.mockResolvedValue(BASE_CREATOR);

      await supertest(app).get('/api/v1/keys/creator-abc/price?quantity=1');
      await supertest(app).get('/api/v1/keys/creator-abc/price?quantity=1');

      // findFirst should have been called exactly once
      expect(mockPrisma.creatorProfile.findFirst).toHaveBeenCalledTimes(1);
   });

   it('uses separate cache entries per quantity', async () => {
      mockPrisma.creatorProfile.findFirst.mockResolvedValue(BASE_CREATOR);

      await supertest(app).get('/api/v1/keys/creator-abc/price?quantity=1');
      await supertest(app).get('/api/v1/keys/creator-abc/price?quantity=2');

      // Each quantity is a distinct cache key → DB called twice
      expect(mockPrisma.creatorProfile.findFirst).toHaveBeenCalledTimes(2);
   });

   it('still responds 200 when cache write fails (graceful degradation)', async () => {
      (cacheSetJson as jest.Mock).mockRejectedValueOnce(new Error('Redis down'));
      mockPrisma.creatorProfile.findFirst.mockResolvedValue(BASE_CREATOR);

      const res = await supertest(app).get('/api/v1/keys/creator-abc/price?quantity=1');
      expect(res.status).toBe(200);
   });

   // ── Curve correctness (smoke) ────────────────────────────────────────────

   it('priceImpactPercent is "5.00" for qty 1 at supply 0 with exponent 1', async () => {
      mockPrisma.creatorProfile.findFirst.mockResolvedValue({
         ...BASE_CREATOR,
         circulatingSupply: 0,
      });

      const res = await supertest(app).get('/api/v1/keys/creator-abc/price?quantity=1');
      expect(res.status).toBe(200);
      // At supply 0, spot = 1_000_000; buying 1 unit, avg unit price is the
      // integral [0,1] which for exp=1 = 1_000_000 * 1 + 100_000 * (1^2 - 0^2)/2 = 1_050_000.
      // Impact = (1_050_000 - 1_000_000) / 1_000_000 * 100 = 5.00
      expect(res.body.data.priceImpactPercent).toBe('5.00');
   });

   // ── Exact values: supply 100, qty 5, exp 1 ──────────────────────────────

   it('returns exact computed values for supply 100, qty 5, exp 1', async () => {
      mockPrisma.creatorProfile.findFirst.mockResolvedValue(BASE_CREATOR);

      const res = await supertest(app).get('/api/v1/keys/creator-abc/price?quantity=5');
      expect(res.status).toBe(200);
      const data = res.body.data;

      // buyCost(100,5) = 1_000_000*5 + 100_000*(105^2 - 100^2)/2
      //                = 5_000_000 + 100_000*(11025-10000)/2
      //                = 5_000_000 + 51_250_000 = 56_250_000
      expect(data.buy.totalCost).toBe('56250000');

      // sellProceeds(100,5) = 1_000_000*5 + 100_000*(100^2 - 95^2)/2
      //                     = 5_000_000 + 100_000*(10000-9025)/2
      //                     = 5_000_000 + 48_750_000 = 53_750_000
      expect(data.sell.totalProceeds).toBe('53750000');

      // impact = (buyUnit - spot) / spot * 100
      //        = (11250000 - 11000000) / 11000000 * 100 ≈ 2.27
      expect(data.priceImpactPercent).toBe('2.27');
   });
});
