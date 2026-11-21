// Unit tests for the volume leaderboard (#785):
//   - Aggregates buy + sell volume per creator from the Activity read model
//   - Returns exactly 20 entries, sorted by descending volume
//   - Serves from cache on repeated calls; falls back to live compute on a
//     cache miss or Redis error
//   - Computes priceChange24h from the creator's price snapshot
//   - Returns an empty array when no trades exist

const mockPrisma = {
   activity: { findMany: jest.fn() },
   creatorProfile: { findMany: jest.fn() },
};
jest.mock('../../utils/prisma.utils', () => ({ prisma: mockPrisma }));

jest.mock('../../utils/logger.utils', () => ({
   logger: { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));

jest.mock('../../config', () => ({
   envConfig: {
      LEADERBOARD_VOLUME_WINDOW_DAYS: 7,
      LEADERBOARD_VOLUME_CACHE_TTL_SECONDS: 300,
   },
}));

const mockRedisClient = {
   get: jest.fn(),
   set: jest.fn(),
   del: jest.fn(),
};
jest.mock('../../utils/redis.utils', () => ({
   getRedis: jest.fn(() => mockRedisClient),
}));

import {
   computeVolumeLeaderboard,
   getVolumeLeaderboard,
   invalidateVolumeLeaderboardCache,
} from './creator-leaderboard-volume.service';

function activity(creatorId: string, amount: number, priceAtTrade: string) {
   return {
      creatorId,
      payload: { amount, price_at_trade: priceAtTrade },
   };
}

function creator(
   id: string,
   displayName: string,
   avatarUrl: string | null,
   currentPrice?: bigint,
   price24hAgo?: bigint
) {
   return {
      id,
      displayName,
      avatarUrl,
      priceSnapshot:
         currentPrice !== undefined
            ? { currentPrice, price24hAgo: price24hAgo ?? currentPrice }
            : null,
   };
}

describe('computeVolumeLeaderboard', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('returns an empty array when no trades exist', async () => {
      mockPrisma.activity.findMany.mockResolvedValue([]);

      const result = await computeVolumeLeaderboard();

      expect(result).toEqual([]);
      expect(mockPrisma.creatorProfile.findMany).not.toHaveBeenCalled();
   });

   it('sums buy and sell volume per creator (amount * price_at_trade)', async () => {
      mockPrisma.activity.findMany.mockResolvedValue([
         activity('creator-a', 10, '100'), // 1000
         activity('creator-a', 5, '100'), // 500 (sell) -> total 1500
      ]);
      mockPrisma.creatorProfile.findMany.mockResolvedValue([
         creator('creator-a', 'Alice', 'https://a.png', 100n, 90n),
      ]);

      const result = await computeVolumeLeaderboard();

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(
         expect.objectContaining({
            rank: 1,
            keyId: 'creator-a',
            creatorName: 'Alice',
            avatarUrl: 'https://a.png',
            totalVolume: '1500',
         })
      );
   });

   it('sorts entries by descending total volume', async () => {
      mockPrisma.activity.findMany.mockResolvedValue([
         activity('low', 1, '100'), // 100
         activity('high', 100, '100'), // 10000
      ]);
      mockPrisma.creatorProfile.findMany.mockResolvedValue([
         creator('low', 'Low Volume', null, 10n, 10n),
         creator('high', 'High Volume', null, 10n, 10n),
      ]);

      const result = await computeVolumeLeaderboard();

      expect(result.map(entry => entry.keyId)).toEqual(['high', 'low']);
      expect(result[0].rank).toBe(1);
      expect(result[1].rank).toBe(2);
   });

   it('caps the result at 20 entries', async () => {
      const activities = Array.from({ length: 25 }, (_, i) =>
         activity(`creator-${i}`, i + 1, '100')
      );
      const creators = Array.from({ length: 25 }, (_, i) =>
         creator(`creator-${i}`, `Creator ${i}`, null, 10n, 10n)
      );
      mockPrisma.activity.findMany.mockResolvedValue(activities);
      mockPrisma.creatorProfile.findMany.mockResolvedValue(creators);

      const result = await computeVolumeLeaderboard();

      expect(result).toHaveLength(20);
      expect(result[0].rank).toBe(1);
      expect(result[19].rank).toBe(20);
   });

   it('computes priceChange24h correctly from the price snapshot', async () => {
      mockPrisma.activity.findMany.mockResolvedValue([
         activity('creator-a', 1, '100'),
      ]);
      mockPrisma.creatorProfile.findMany.mockResolvedValue([
         creator('creator-a', 'Alice', null, 120n, 100n), // +20%
      ]);

      const result = await computeVolumeLeaderboard();

      expect(result[0].priceChange24h).toBe(20);
   });

   it('returns priceChange24h=null when the creator has no price snapshot', async () => {
      mockPrisma.activity.findMany.mockResolvedValue([
         activity('creator-a', 1, '100'),
      ]);
      mockPrisma.creatorProfile.findMany.mockResolvedValue([
         creator('creator-a', 'Alice', null),
      ]);

      const result = await computeVolumeLeaderboard();

      expect(result[0].priceChange24h).toBeNull();
   });
});

describe('getVolumeLeaderboard (caching)', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('serves from Redis cache on a hit without querying the database', async () => {
      const cachedPayload = [
         {
            rank: 1,
            keyId: 'creator-a',
            creatorName: 'Alice',
            avatarUrl: null,
            totalVolume: '1000',
            priceChange24h: 5,
         },
      ];
      mockRedisClient.get.mockResolvedValue(JSON.stringify(cachedPayload));

      const result = await getVolumeLeaderboard();

      expect(result).toEqual(cachedPayload);
      expect(mockPrisma.activity.findMany).not.toHaveBeenCalled();
   });

   it('computes live and populates the cache on a miss', async () => {
      mockRedisClient.get.mockResolvedValue(null);
      mockPrisma.activity.findMany.mockResolvedValue([
         activity('creator-a', 1, '100'),
      ]);
      mockPrisma.creatorProfile.findMany.mockResolvedValue([
         creator('creator-a', 'Alice', null, 10n, 10n),
      ]);

      const result = await getVolumeLeaderboard();

      expect(result).toHaveLength(1);
      expect(mockRedisClient.set).toHaveBeenCalledWith(
         'leaderboard:volume:v1',
         expect.any(String),
         'EX',
         300
      );
   });

   it('falls back to a live computation when Redis read fails', async () => {
      mockRedisClient.get.mockRejectedValue(new Error('redis down'));
      mockPrisma.activity.findMany.mockResolvedValue([]);

      const result = await getVolumeLeaderboard();

      expect(result).toEqual([]);
   });
});

describe('invalidateVolumeLeaderboardCache', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('deletes the cache key', async () => {
      mockRedisClient.del.mockResolvedValue(1);

      await invalidateVolumeLeaderboardCache();

      expect(mockRedisClient.del).toHaveBeenCalledWith('leaderboard:volume:v1');
   });

   it('does not throw when Redis is unavailable', async () => {
      mockRedisClient.del.mockRejectedValue(new Error('redis down'));

      await expect(invalidateVolumeLeaderboardCache()).resolves.toBeUndefined();
   });
});
