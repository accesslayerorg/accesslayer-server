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
      scan: jest.fn(async (_cursor: string, _match: string, _pattern: string) => {
         return ['0', []];
      }),
   }),
   cacheGetJson: jest.fn(async <T>(key: string): Promise<T | null> => {
      const val = redisStore.get(key);
      return val ? JSON.parse(val) : null;
   }),
   cacheSetJson: jest.fn(async (key: string, value: unknown) => {
      redisStore.set(key, JSON.stringify(value));
   }),
   cacheInvalidate: jest.fn(async (...keysOrPatterns: string[]) => {
      for (const k of keysOrPatterns) {
         if (k.includes('*')) {
            const prefix = k.replace('*', '');
            for (const key of Array.from(redisStore.keys())) {
               if (key.startsWith(prefix)) {
                  redisStore.delete(key);
               }
            }
         } else {
            redisStore.delete(k);
         }
      }
   }),
}));

jest.mock('../../../utils/prisma.utils', () => ({
   prisma: {
      creatorProfile: {
         findFirst: jest.fn(),
         findUnique: jest.fn(),
      },
      creatorPriceHistory: {
         findFirst: jest.fn(),
         findMany: jest.fn(),
      },
      creatorPriceSnapshot: {
         findUnique: jest.fn(),
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
import { cacheSetJson } from '../../../utils/redis.utils';
import { invalidateKeyTwapCache } from '../key-twap-window.service';

const app = express();
app.use(express.json());
app.use('/api/v1/keys', keysRouter);

describe('GET /api/v1/keys/:keyId/twap/trade-history (#866)', () => {
   const now = new Date('2026-09-24T12:00:00.000Z');

   beforeEach(() => {
      redisStore.clear();
      jest.clearAllMocks();
      jest.useFakeTimers().setSystemTime(now);
   });

   afterEach(() => jest.useRealTimers());

   it('returns 422 for invalid or missing window param', async () => {
      const res1 = await request(app).get('/api/v1/keys/creator-1/twap/trade-history');
      expect(res1.status).toBe(422);

      const res2 = await request(app).get('/api/v1/keys/creator-1/twap/trade-history?window=invalid');
      expect(res2.status).toBe(422);
   });

   it('returns 404 when key is not found', async () => {
      (prisma.creatorProfile.findFirst as jest.Mock).mockResolvedValue(null);

      const res = await request(app).get('/api/v1/keys/nonexistent/twap/trade-history?window=1h');
      expect(res.status).toBe(404);
   });

   it('uses the available price when the window has only one snapshot', async () => {
      (prisma.creatorProfile.findFirst as jest.Mock).mockResolvedValue({
         id: 'creator-1',
         handle: 'creator-1',
      });
      (prisma.creatorPriceHistory.findMany as jest.Mock).mockResolvedValue([
         {
            id: 'h1',
            creatorId: 'creator-1',
            price: 10000000n,
            recordedAt: new Date(now.getTime() - 10 * 60 * 1000),
         },
      ]);
      (prisma.creatorPriceHistory.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.creatorPriceSnapshot.findUnique as jest.Mock).mockResolvedValue({
         currentPrice: 10000000n,
      });

      const res = await request(app).get('/api/v1/keys/creator-1/twap/trade-history?window=1h');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.twapPrice).toBe('10000000');
      expect(res.body.data.spotPrice).toBe('10000000');
      expect(res.body.data.snapshotCount).toBe(1);
      expect(res.body.data.windowLedgers).toBe(720);
   });

   it('falls back to the current spot price when history is empty', async () => {
      (prisma.creatorProfile.findFirst as jest.Mock).mockResolvedValue({
         id: 'creator-1',
         handle: 'creator-1',
      });
      (prisma.creatorPriceHistory.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.creatorPriceHistory.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.creatorPriceSnapshot.findUnique as jest.Mock).mockResolvedValue({
         currentPrice: 12500000n,
      });

      const res = await request(app).get('/api/v1/keys/creator-1/twap/trade-history?window=1h');

      expect(res.status).toBe(200);
      expect(res.body.data.twapPrice).toBe('12500000');
      expect(res.body.data.spotPrice).toBe('12500000');
      expect(res.body.data.snapshotCount).toBe(0);
   });

   it('computes twapPrice correctly with spotPrice across requested window (24h)', async () => {
      (prisma.creatorProfile.findFirst as jest.Mock).mockResolvedValue({
         id: 'creator-1',
         handle: 'creator-1',
      });
      // Two equal-duration price intervals across the 24-hour window.
      const t0 = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const t1 = new Date(now.getTime() - 12 * 60 * 60 * 1000);
      (prisma.creatorPriceHistory.findMany as jest.Mock).mockResolvedValue([
         { id: 'h1', creatorId: 'creator-1', price: 10000000n, recordedAt: t0 },
         { id: 'h2', creatorId: 'creator-1', price: 20000000n, recordedAt: t1 },
      ]);
      (prisma.creatorPriceHistory.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.creatorPriceSnapshot.findUnique as jest.Mock).mockResolvedValue({
         currentPrice: 20000000n,
      });

      const res = await request(app).get('/api/v1/keys/creator-1/twap/trade-history?window=24h');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.twapPrice).toBe('15000000');
      expect(res.body.data.spotPrice).toBe('20000000');
      expect(res.body.data.snapshotCount).toBe(2);
      expect(res.body.data.windowLedgers).toBe(17280);
   });

   it('caches for the requested window and invalidates on a trade', async () => {
      (prisma.creatorProfile.findFirst as jest.Mock).mockResolvedValue({
         id: 'creator-1',
         handle: 'creator-1',
      });
      (prisma.creatorPriceHistory.findMany as jest.Mock).mockResolvedValue([
         { id: 'h1', creatorId: 'creator-1', price: 10000000n, recordedAt: new Date(now.getTime() - 1000) },
         { id: 'h2', creatorId: 'creator-1', price: 20000000n, recordedAt: now },
      ]);
      (prisma.creatorPriceSnapshot.findUnique as jest.Mock).mockResolvedValue({
         currentPrice: 20000000n,
      });

      // First call populates cache
      const res1 = await request(app).get('/api/v1/keys/creator-1/twap/trade-history?window=7d');
      expect(res1.status).toBe(200);
      expect(prisma.creatorPriceHistory.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.creatorPriceHistory.findFirst).toHaveBeenCalledWith(
         expect.objectContaining({
            where: {
               creatorId: 'creator-1',
               recordedAt: { lt: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) },
            },
         })
      );
      expect(cacheSetJson).toHaveBeenCalledWith(
         'key:twap:creator-1:7d',
         expect.any(Object),
         7 * 24 * 60 * 60
      );

      // Second call hits cache
      const res2 = await request(app).get('/api/v1/keys/creator-1/twap/trade-history?window=7d');
      expect(res2.status).toBe(200);
      expect(prisma.creatorPriceHistory.findMany).toHaveBeenCalledTimes(1);

      // Invalidate cache
      await invalidateKeyTwapCache('creator-1');

      // Third call fetches from DB
      const res3 = await request(app).get('/api/v1/keys/creator-1/twap/trade-history?window=7d');
      expect(res3.status).toBe(200);
      expect(prisma.creatorPriceHistory.findMany).toHaveBeenCalledTimes(2);
   });
});
