const redisStore = new Map<string, string>();

jest.mock('../../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn(async <T>(key: string): Promise<T | null> => {
      const val = redisStore.get(key);
      return val ? JSON.parse(val) : null;
   }),
   cacheSetJson: jest.fn(async (key: string, value: unknown) => {
      redisStore.set(key, JSON.stringify(value));
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

const app = express();
app.use(express.json());
app.use('/api/v1/keys', keysRouter);

describe('GET /api/v1/keys/:keyId/simulate (#870)', () => {
   beforeEach(() => {
      redisStore.clear();
      jest.clearAllMocks();
   });

   it('returns 422 for invalid or missing side', async () => {
      const res1 = await request(app).get('/api/v1/keys/creator-1/simulate?quantity=5');
      expect(res1.status).toBe(422);

      const res2 = await request(app).get('/api/v1/keys/creator-1/simulate?side=invalid&quantity=5');
      expect(res2.status).toBe(422);
   });

   it('returns 422 for missing or non-positive quantity', async () => {
      const res1 = await request(app).get('/api/v1/keys/creator-1/simulate?side=buy');
      expect(res1.status).toBe(422);

      const res2 = await request(app).get('/api/v1/keys/creator-1/simulate?side=buy&quantity=0');
      expect(res2.status).toBe(422);

      const res3 = await request(app).get('/api/v1/keys/creator-1/simulate?side=buy&quantity=-5');
      expect(res3.status).toBe(422);

      const res4 = await request(app).get('/api/v1/keys/creator-1/simulate?side=buy&quantity=abc');
      expect(res4.status).toBe(422);
   });

   it('returns 404 when key is not found', async () => {
      (prisma.creatorProfile.findFirst as jest.Mock).mockResolvedValue(null);

      const res = await request(app).get('/api/v1/keys/nonexistent/simulate?side=buy&quantity=10');
      expect(res.status).toBe(404);
   });

   it('returns 422 when sell quantity exceeds circulating supply', async () => {
      (prisma.creatorProfile.findFirst as jest.Mock).mockResolvedValue({
         id: 'creator-1',
         handle: 'creator-1',
         circulatingSupply: 50,
         baseExponent: 1,
      });

      const res = await request(app).get(
         '/api/v1/keys/creator-1/simulate?side=sell&quantity=100'
      );
      expect(res.status).toBe(422);
      expect(res.body.error.message).toContain('exceeds circulating supply');
   });

   it('simulates buy trade across single and batch quantities', async () => {
      (prisma.creatorProfile.findFirst as jest.Mock).mockResolvedValue({
         id: 'creator-1',
         handle: 'creator-1',
         circulatingSupply: 100,
         baseExponent: 1,
      });

      const res = await request(app).get(
         '/api/v1/keys/creator-1/simulate?side=buy&quantity=1,5,10'
      );
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.keyId).toBe('creator-1');
      expect(res.body.data.side).toBe('buy');
      expect(res.body.data.circulatingSupply).toBe(100);
      expect(res.body.data.simulations).toHaveLength(3);

      const sim1 = res.body.data.simulations[0];
      expect(sim1.quantity).toBe(1);
      expect(BigInt(sim1.totalCost)).toBeGreaterThan(0n);
      expect(sim1.pricePerUnit).toBeDefined();
      expect(sim1.priceImpact).toBeDefined();

      const sim10 = res.body.data.simulations[2];
      expect(sim10.quantity).toBe(10);
      expect(BigInt(sim10.totalCost)).toBeGreaterThan(BigInt(sim1.totalCost));
   });

   it('simulates sell trade and caches result in Redis', async () => {
      (prisma.creatorProfile.findFirst as jest.Mock).mockResolvedValue({
         id: 'creator-1',
         handle: 'creator-1',
         circulatingSupply: 50,
         baseExponent: 1,
      });

      const res1 = await request(app).get(
         '/api/v1/keys/creator-1/simulate?side=sell&quantity=10'
      );
      expect(res1.status).toBe(200);
      expect(res1.body.data.side).toBe('sell');
      expect(prisma.creatorProfile.findFirst).toHaveBeenCalledTimes(1);

      // Second request within cache TTL
      const res2 = await request(app).get(
         '/api/v1/keys/creator-1/simulate?side=sell&quantity=10'
      );
      expect(res2.status).toBe(200);
      expect(res2.body.data.side).toBe('sell');
      expect(prisma.creatorProfile.findFirst).toHaveBeenCalledTimes(1); // Cached!
   });
});
