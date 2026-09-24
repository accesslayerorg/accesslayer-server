const redisStore = new Map<string, string>();

jest.mock('../../../utils/redis.utils', () => ({
   getRedis: () => ({
      get: jest.fn(async (key: string) => redisStore.get(key) ?? null),
      set: jest.fn(async (key: string, value: string) => {
         redisStore.set(key, value);
         return 'OK';
      }),
      del: jest.fn(async (key: string) => {
         redisStore.delete(key);
         return 1;
      }),
   }),
   cacheGetJson: jest.fn(async <T>(key: string): Promise<T | null> => {
      const val = redisStore.get(key);
      return val ? JSON.parse(val) : null;
   }),
   cacheSetJson: jest.fn(async (key: string, value: unknown) => {
      redisStore.set(key, JSON.stringify(value));
   }),
   cacheInvalidate: jest.fn(async (...keys: string[]) => {
      keys.forEach(k => redisStore.delete(k));
   }),
}));

jest.mock('../../../utils/prisma.utils', () => ({
   prisma: {
      creatorProfile: {
         findFirst: jest.fn(),
      },
   },
}));

jest.mock('../../../utils/logger.utils', () => ({
   logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
   },
}));

import request from 'supertest';
import express from 'express';
import keysRouter from '../keys.routes';
import { prisma } from '../../../utils/prisma.utils';
import { computeBuyCost, computeSellPayout } from '../../../utils/pricing.utils';

const app = express();
app.use(express.json());
app.use('/api/v1/keys', keysRouter);

describe('GET /api/v1/keys/:keyId/simulate (#870)', () => {
   beforeEach(() => {
      redisStore.clear();
      jest.clearAllMocks();
   });

   it('returns 422 when side or quantity param is missing or invalid', async () => {
      const res1 = await request(app).get('/api/v1/keys/creator-1/simulate');
      expect(res1.status).toBe(422);

      const res2 = await request(app).get('/api/v1/keys/creator-1/simulate?side=invalid&quantity=1');
      expect(res2.status).toBe(422);

      const res3 = await request(app).get('/api/v1/keys/creator-1/simulate?side=buy&quantity=-5');
      expect(res3.status).toBe(422);

      const res4 = await request(app).get('/api/v1/keys/creator-1/simulate?side=buy&quantity=abc');
      expect(res4.status).toBe(422);
   });

   it('returns 404 when creator is not found', async () => {
      (prisma.creatorProfile.findFirst as jest.Mock).mockResolvedValue(null);

      const res = await request(app).get('/api/v1/keys/nonexistent/simulate?side=buy&quantity=1');
      expect(res.status).toBe(404);
   });

   it('calculates buy simulation correctly with totalCost, pricePerUnit, and priceImpact', async () => {
      const currentSupply = 10;
      const royaltyBps = 100; // 1%
      (prisma.creatorProfile.findFirst as jest.Mock).mockResolvedValue({
         id: 'creator-1',
         handle: 'creator-1',
         circulatingSupply: String(currentSupply),
         creatorRoyaltyBuyBps: royaltyBps,
         creatorRoyaltySellBps: 0,
      });

      const res = await request(app).get('/api/v1/keys/creator-1/simulate?side=buy&quantity=5');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const expectedCost = computeBuyCost(currentSupply, 5, royaltyBps);
      const spotPrice = computeBuyCost(currentSupply, 1, 0);
      const expectedPpu = Number(expectedCost) / 5;
      const expectedImpact = Number((((expectedPpu - Number(spotPrice)) / Number(spotPrice)) * 100).toFixed(2));

      expect(res.body.data.side).toBe('buy');
      expect(res.body.data.quantity).toBe(5);
      expect(res.body.data.totalCost).toBe(expectedCost.toString());
      expect(res.body.data.pricePerUnit).toBe(Math.round(expectedPpu).toString());
      expect(res.body.data.priceImpact).toBe(expectedImpact);
      expect(res.body.data.spotPrice).toBe(spotPrice.toString());
   });

   it('calculates sell simulation correctly with totalProceeds, pricePerUnit, and priceImpact', async () => {
      const currentSupply = 10;
      const royaltyBps = 200; // 2%
      (prisma.creatorProfile.findFirst as jest.Mock).mockResolvedValue({
         id: 'creator-1',
         handle: 'creator-1',
         circulatingSupply: String(currentSupply),
         creatorRoyaltyBuyBps: 0,
         creatorRoyaltySellBps: royaltyBps,
      });

      const res = await request(app).get('/api/v1/keys/creator-1/simulate?side=sell&quantity=3');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const expectedProceeds = computeSellPayout(currentSupply, 3, royaltyBps);
      const spotPrice = computeBuyCost(currentSupply, 1, 0);
      const expectedPpu = Number(expectedProceeds) / 3;
      const expectedImpact = Number((((expectedPpu - Number(spotPrice)) / Number(spotPrice)) * 100).toFixed(2));

      expect(res.body.data.side).toBe('sell');
      expect(res.body.data.quantity).toBe(3);
      expect(res.body.data.totalProceeds).toBe(expectedProceeds.toString());
      expect(res.body.data.pricePerUnit).toBe(Math.round(expectedPpu).toString());
      expect(res.body.data.priceImpact).toBe(expectedImpact);
   });

   it('returns multiple quantities simulation in a single call', async () => {
      (prisma.creatorProfile.findFirst as jest.Mock).mockResolvedValue({
         id: 'creator-1',
         handle: 'creator-1',
         circulatingSupply: '10',
         creatorRoyaltyBuyBps: 0,
         creatorRoyaltySellBps: 0,
      });

      const res = await request(app).get('/api/v1/keys/creator-1/simulate?side=buy&quantities=1,5,10');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.simulations).toBeDefined();
      expect(res.body.data.simulations.length).toBe(3);
      expect(res.body.data.simulations[0].quantity).toBe(1);
      expect(res.body.data.simulations[1].quantity).toBe(5);
      expect(res.body.data.simulations[2].quantity).toBe(10);
   });

   it('caches simulation results in Redis for 15s TTL', async () => {
      (prisma.creatorProfile.findFirst as jest.Mock).mockResolvedValue({
         id: 'creator-1',
         handle: 'creator-1',
         circulatingSupply: '10',
         creatorRoyaltyBuyBps: 0,
         creatorRoyaltySellBps: 0,
      });

      const res1 = await request(app).get('/api/v1/keys/creator-1/simulate?side=buy&quantity=2');
      expect(res1.status).toBe(200);
      expect(prisma.creatorProfile.findFirst).toHaveBeenCalledTimes(1);

      const res2 = await request(app).get('/api/v1/keys/creator-1/simulate?side=buy&quantity=2');
      expect(res2.status).toBe(200);
      // Served from Redis, DB not called again
      expect(prisma.creatorProfile.findFirst).toHaveBeenCalledTimes(1);
   });
});
