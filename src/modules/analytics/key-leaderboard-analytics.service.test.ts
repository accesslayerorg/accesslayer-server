import {
   computeDailySnapshotChange,
   getKeyAnalyticsLeaderboard,
   rankKeyAnalyticsLeaderboard,
} from './key-leaderboard-analytics.service';
import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      creatorProfile: { findMany: jest.fn() },
      keyOwnership: { groupBy: jest.fn() },
      creatorReputation: { findMany: jest.fn() },
      activity: { findMany: jest.fn() },
      keyAnalyticsSnapshot: { findMany: jest.fn() },
   },
}));

jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn(),
   cacheSetJson: jest.fn(),
}));

jest.mock('../../utils/logger.utils', () => ({
   logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

const mockPrisma = prisma as unknown as {
   creatorProfile: { findMany: jest.Mock };
   keyOwnership: { groupBy: jest.Mock };
   creatorReputation: { findMany: jest.Mock };
   activity: { findMany: jest.Mock };
   keyAnalyticsSnapshot: { findMany: jest.Mock };
};

const DAY1 = new Date('2026-11-23T00:00:00.000Z');
const DAY2 = new Date('2026-11-24T00:00:00.000Z');

describe('computeDailySnapshotChange', () => {
   it('returns the percent change against the snapshot one day earlier', () => {
      expect(
         computeDailySnapshotChange([
            { snapshotDate: DAY1, price: 100n },
            { snapshotDate: DAY2, price: 110n },
         ])
      ).toBe(10);
   });

   it('returns null when the previous day is missing from the series', () => {
      expect(
         computeDailySnapshotChange([
            { snapshotDate: new Date('2026-11-20T00:00:00.000Z'), price: 100n },
            { snapshotDate: DAY2, price: 110n },
         ])
      ).toBeNull();
   });

   it('returns null when the earlier price is zero', () => {
      expect(
         computeDailySnapshotChange([
            { snapshotDate: DAY1, price: 0n },
            { snapshotDate: DAY2, price: 110n },
         ])
      ).toBeNull();
   });

   it('returns null with fewer than two snapshots', () => {
      expect(
         computeDailySnapshotChange([{ snapshotDate: DAY2, price: 110n }])
      ).toBeNull();
   });
});

describe('rankKeyAnalyticsLeaderboard', () => {
   const rows = [
      { keyId: 'key-2', keyName: 'Two', creator: 'two', value: 9n, change: 1.5 },
      { keyId: 'key-1', keyName: 'One', creator: 'one', value: 9n, change: null },
      { keyId: 'key-3', keyName: 'Three', creator: 'three', value: 5n, change: -2 },
   ];

   it('ranks by value descending and breaks ties by key id', () => {
      const entries = rankKeyAnalyticsLeaderboard('volume', rows, 100);

      expect(entries.map(entry => [entry.rank, entry.key_id])).toEqual([
         [1, 'key-1'],
         [2, 'key-2'],
         [3, 'key-3'],
      ]);
      expect(entries[0]).toEqual({
         rank: 1,
         key_id: 'key-1',
         key_name: 'One',
         creator: 'one',
         metric_value: '9',
         '24h_change': null,
      });
   });

   it('returns numeric metric values for holders and reputation', () => {
      const entries = rankKeyAnalyticsLeaderboard('holders', rows, 1);

      expect(entries).toHaveLength(1);
      expect(entries[0].metric_value).toBe(9);
   });
});

describe('getKeyAnalyticsLeaderboard', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('serves the requested slice from a warm cache without querying the database', async () => {
      const cached = [1, 2, 3].map(rank => ({
         rank,
         key_id: `key-${rank}`,
         key_name: `Key ${rank}`,
         creator: `creator-${rank}`,
         metric_value: 10 - rank,
         '24h_change': null,
      }));
      (cacheGetJson as jest.Mock).mockResolvedValue(cached);

      const items = await getKeyAnalyticsLeaderboard('holders', 2);

      expect(items.map(item => item.rank)).toEqual([1, 2]);
      expect(mockPrisma.creatorProfile.findMany).not.toHaveBeenCalled();
   });

   it('computes and caches the ranking for five minutes on a cache miss', async () => {
      (cacheGetJson as jest.Mock).mockResolvedValue(null);
      mockPrisma.creatorProfile.findMany.mockResolvedValue([]);

      const items = await getKeyAnalyticsLeaderboard('reputation', 20);

      expect(items).toEqual([]);
      expect(cacheSetJson).toHaveBeenCalledWith(
         'analytics:keys:leaderboard:reputation:v1',
         [],
         300
      );
   });
});
