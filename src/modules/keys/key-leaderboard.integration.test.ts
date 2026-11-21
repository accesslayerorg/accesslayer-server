// src/modules/keys/key-leaderboard.integration.test.ts
import supertest from 'supertest';
import app from '../../app';
import { prisma } from '../../utils/prisma.utils';
import { cacheSetJson, getRedis } from '../../utils/redis.utils';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      creatorProfile: {
         findMany: jest.fn(),
      },
      keyOwnership: {
         groupBy: jest.fn(),
      },
      activity: {
         findMany: jest.fn(),
      },
      keyLeaderboard: {
         findMany: jest.fn(),
         findUnique: jest.fn(),
         count: jest.fn(),
      },
      $disconnect: jest.fn(),
   },
}));

jest.mock('../../utils/redis.utils', () => ({
   getRedis: jest.fn(),
   cacheGetJson: jest.fn().mockResolvedValue(null),
   cacheSetJson: jest.fn().mockResolvedValue(undefined),
   cacheInvalidate: jest.fn().mockResolvedValue(undefined),
}));

const mockPrisma = prisma as unknown as {
   creatorProfile: { findMany: jest.Mock };
   keyOwnership: { groupBy: jest.Mock };
   activity: { findMany: jest.Mock };
   keyLeaderboard: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      count: jest.Mock;
   };
};

const mockGetRedis = getRedis as jest.Mock;

describe('GET /api/v1/keys/leaderboard', () => {
   const now = new Date('2026-06-01T12:00:00Z');
   const olderDate = new Date('2026-05-01T12:00:00Z');
   const newerDate = new Date('2026-05-15T12:00:00Z');

   const creators = [
      {
         id: 'key-1',
         handle: 'alice',
         displayName: 'Alice',
         avatarUrl: null,
         createdAt: olderDate,
         priceSnapshot: { currentPrice: 200n, price24hAgo: 100n },
      },
      {
         id: 'key-2',
         handle: 'bob',
         displayName: 'Bob',
         avatarUrl: null,
         createdAt: newerDate,
         priceSnapshot: { currentPrice: 150n, price24hAgo: 100n },
      },
      {
         id: 'key-3',
         handle: 'charlie',
         displayName: 'Charlie',
         avatarUrl: null,
         createdAt: now,
         priceSnapshot: { currentPrice: 300n, price24hAgo: 100n },
      },
   ];

   beforeEach(() => {
      jest.clearAllMocks();
      mockGetRedis.mockReturnValue(null);
      mockPrisma.creatorProfile.findMany.mockResolvedValue(creators);
      mockPrisma.keyOwnership.groupBy.mockResolvedValue([
         { creatorId: 'key-1', _count: { ownerAddress: 10 } },
         { creatorId: 'key-2', _count: { ownerAddress: 10 } }, // Tied holder count with key-1
         { creatorId: 'key-3', _count: { ownerAddress: 5 } },
      ]);
      mockPrisma.activity.findMany.mockResolvedValue([
         {
            creatorId: 'key-1',
            createdAt: new Date(),
            payload: { amount: '100', price_at_trade: '10' }, // volume = 1000
         },
         {
            creatorId: 'key-2',
            createdAt: new Date(),
            payload: { amount: '200', price_at_trade: '10' }, // volume = 2000
         },
         {
            creatorId: 'key-3',
            createdAt: new Date(),
            payload: { amount: '50', price_at_trade: '10' }, // volume = 500
         },
      ]);
      mockPrisma.keyLeaderboard.findMany.mockResolvedValue([]);
      mockPrisma.keyLeaderboard.findUnique.mockResolvedValue(null);
      mockPrisma.keyLeaderboard.count.mockResolvedValue(0);
   });

   it('defaults to sort_by=holder_count and breaks ties by creation date ascending', async () => {
      const res = await supertest(app).get('/api/v1/keys/leaderboard');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      const items = res.body.data.items;
      expect(items).toHaveLength(3);

      // key-1 (10 holders, olderDate) and key-2 (10 holders, newerDate) tie on holders.
      // key-1 should win tie-break due to older createdAt.
      expect(items[0].keyId).toBe('key-1');
      expect(items[1].keyId).toBe('key-2');
      expect(items[2].keyId).toBe('key-3');
      expect(items[0].rank).toBe(1);
      expect(items[1].rank).toBe(2);
      expect(items[2].rank).toBe(3);
   });

   it('sorts correctly by volume_24h', async () => {
      const res = await supertest(app).get('/api/v1/keys/leaderboard?sort_by=volume_24h');

      expect(res.status).toBe(200);
      const items = res.body.data.items;
      expect(items).toHaveLength(3);
      // key-2 volume = 2000, key-1 volume = 1000, key-3 volume = 500
      expect(items[0].keyId).toBe('key-2');
      expect(items[1].keyId).toBe('key-1');
      expect(items[2].keyId).toBe('key-3');
   });

   it('sorts correctly by price_change', async () => {
      const res = await supertest(app).get('/api/v1/keys/leaderboard?sort_by=price_change');

      expect(res.status).toBe(200);
      const items = res.body.data.items;
      expect(items).toHaveLength(3);
      // key-3 price change = +200%, key-1 = +100%, key-2 = +50%
      expect(items[0].keyId).toBe('key-3');
      expect(items[1].keyId).toBe('key-1');
      expect(items[2].keyId).toBe('key-2');
   });

   it('respects limit parameter and rejects invalid limit with 400', async () => {
      const resValid = await supertest(app).get('/api/v1/keys/leaderboard?limit=2');
      expect(resValid.status).toBe(200);
      expect(resValid.body.data.items).toHaveLength(2);

      const resInvalid = await supertest(app).get('/api/v1/keys/leaderboard?limit=101');
      expect(resInvalid.status).toBe(400);
   });

   it('uses Redis cache when available', async () => {
      const mockRedisClient = {
         get: jest.fn().mockResolvedValue(
            JSON.stringify([
               {
                  rank: 1,
                  keyId: 'cached-key',
                  creatorName: 'Cached',
                  handle: 'cached',
                  avatarUrl: null,
                  holder_count: 99,
                  volume_24h: '0',
                  volume_7d: '0',
                  price_change: 0,
                  metricValue: 99,
               },
            ])
         ),
         set: jest.fn().mockResolvedValue('OK'),
      };
      mockGetRedis.mockReturnValue(mockRedisClient);

      const res = await supertest(app).get('/api/v1/keys/leaderboard');
      expect(res.status).toBe(200);
      expect(res.body.data.items[0].keyId).toBe('cached-key');
      expect(mockRedisClient.get).toHaveBeenCalled();
   });

   it('returns an empty list for a key with no indexed leaderboard rows', async () => {
      const res = await supertest(app).get(
         '/api/v1/keys/key-empty/leaderboard?metric=volume'
      );

      expect(res.status).toBe(200);
      expect(res.body.data.items).toEqual([]);
      expect(mockPrisma.keyLeaderboard.findMany).toHaveBeenCalledWith(
         expect.objectContaining({
            where: { creatorId: 'key-empty' },
            take: 20,
         })
      );
   });

   it('ranks per-key leaderboard entries by the requested metric', async () => {
      mockPrisma.keyLeaderboard.findMany.mockResolvedValue([
         { wallet: 'GAAA', volume: 900n, pnl: 3n, holdingDays: 1n },
         { wallet: 'GBBB', volume: 800n, pnl: 10n, holdingDays: 5n },
      ]);

      const res = await supertest(app).get(
         '/api/v1/keys/key-1/leaderboard?metric=volume&limit=2'
      );

      expect(res.status).toBe(200);
      expect(res.body.data.items).toEqual([
         { rank: 1, wallet: 'GAAA', score: '900' },
         { rank: 2, wallet: 'GBBB', score: '800' },
      ]);
      expect(mockPrisma.keyLeaderboard.findMany).toHaveBeenCalledWith(
         expect.objectContaining({
            orderBy: [{ volume: 'desc' }, { wallet: 'asc' }],
            take: 2,
         })
      );
      expect(cacheSetJson).toHaveBeenCalledWith(
         'key:leaderboard:key-1:volume:2',
         res.body.data.items,
         60
      );
   });

   it.each([
      ['volume', 'volume'],
      ['pnl', 'pnl'],
      ['holding_days', 'holdingDays'],
   ])('supports the %s ranking metric', async (metric, field) => {
      mockPrisma.keyLeaderboard.findMany.mockResolvedValue([
         { wallet: 'GAAA', volume: 9n, pnl: 3n, holdingDays: 1n },
      ]);

      const res = await supertest(app).get(
         `/api/v1/keys/key-1/leaderboard?metric=${metric}`
      );

      expect(res.status).toBe(200);
      expect(res.body.data.items).toEqual([
         {
            rank: 1,
            wallet: 'GAAA',
            score: metric === 'volume' ? '9' : metric === 'pnl' ? '3' : '1',
         },
      ]);
      expect(mockPrisma.keyLeaderboard.findMany).toHaveBeenCalledWith(
         expect.objectContaining({
            orderBy: [{ [field]: 'desc' }, { wallet: 'asc' }],
         })
      );
   });

   it('returns rank and score for each metric using the same tie ordering', async () => {
      mockPrisma.keyLeaderboard.findUnique.mockResolvedValue({
         wallet: 'GABC',
         volume: 100n,
         pnl: -5n,
         holdingDays: 20n,
      });
      mockPrisma.keyLeaderboard.count
         .mockResolvedValueOnce(2)
         .mockResolvedValueOnce(0)
         .mockResolvedValueOnce(1);

      const res = await supertest(app).get(
         '/api/v1/keys/key-1/leaderboard/GABC'
      );

      expect(res.status).toBe(200);
      expect(res.body.data.metrics).toEqual({
         volume: { rank: 3, score: '100' },
         pnl: { rank: 1, score: '-5' },
         holding_days: { rank: 2, score: '20' },
      });
      expect(mockPrisma.keyLeaderboard.count).toHaveBeenNthCalledWith(
         1,
         expect.objectContaining({
            where: {
               creatorId: 'key-1',
               OR: [
                  { volume: { gt: 100n } },
                  { volume: 100n, wallet: { lt: 'GABC' } },
               ],
            },
         })
      );
   });

   it('rejects an unsupported per-key leaderboard metric', async () => {
      const res = await supertest(app).get(
         '/api/v1/keys/key-1/leaderboard?metric=holders'
      );

      expect(res.status).toBe(400);
   });
});
