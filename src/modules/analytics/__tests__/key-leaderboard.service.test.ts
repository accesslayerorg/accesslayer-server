// src/modules/analytics/__tests__/key-leaderboard.service.test.ts
let cacheStore = new Map<string, any>();

jest.mock('../../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn(async (key: string) => cacheStore.get(key) ?? null),
   cacheSetJson: jest.fn(async (key: string, val: any) => {
      cacheStore.set(key, val);
   }),
   cacheInvalidate: jest.fn(async (key: string) => {
      cacheStore.delete(key);
   }),
   getRedis: jest.fn(() => ({
      keys: jest.fn(async () => Array.from(cacheStore.keys())),
   })),
}));

const prismaMock = {
   creatorProfile: {
      findMany: jest.fn(),
   },
   trade: {
      findMany: jest.fn(),
   },
   keyOwnership: {
      groupBy: jest.fn(),
   },
   creatorReputation: {
      findMany: jest.fn(),
   },
};

jest.mock('../../../utils/prisma.utils', () => ({
   prisma: prismaMock,
}));

import {
   getKeyDiscoveryLeaderboard,
   invalidateDiscoveryLeaderboardCache,
} from '../key-leaderboard.service';

describe('key-leaderboard.service', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      cacheStore.clear();
   });

   it('ranks keys correctly by volume and computes 24h change', async () => {
      prismaMock.creatorProfile.findMany.mockResolvedValueOnce([
         { id: 'c1', displayName: 'Creator One', handle: 'c_one' },
         { id: 'c2', displayName: 'Creator Two', handle: 'c_two' },
      ]);

      // Recent trades: c1 has 1000 volume, c2 has 500
      prismaMock.trade.findMany
         .mockResolvedValueOnce([
            { creatorId: 'c1', price: '100', quantity: '10' },
            { creatorId: 'c2', price: '50', quantity: '10' },
         ])
         // Older trades: c1 had 500 (100% increase), c2 had 1000 (-50% decrease)
         .mockResolvedValueOnce([
            { creatorId: 'c1', price: '50', quantity: '10' },
            { creatorId: 'c2', price: '100', quantity: '10' },
         ]);

      const res = await getKeyDiscoveryLeaderboard('volume', 10);

      expect(res).toHaveLength(2);
      expect(res[0].rank).toBe(1);
      expect(res[0].key_id).toBe('c1');
      expect(res[0].metric_value).toBe('1000');
      expect(res[0]['24h_change']).toBe('+100%');

      expect(res[1].rank).toBe(2);
      expect(res[1].key_id).toBe('c2');
      expect(res[1].metric_value).toBe('500');
      expect(res[1]['24h_change']).toBe('-50%');
   });

   it('ranks keys correctly by holder count', async () => {
      prismaMock.creatorProfile.findMany.mockResolvedValueOnce([
         { id: 'c1', displayName: 'Creator One', handle: 'c_one' },
         { id: 'c2', displayName: 'Creator Two', handle: 'c_two' },
      ]);

      prismaMock.keyOwnership.groupBy.mockResolvedValueOnce([
         { creatorId: 'c2', _count: { ownerAddress: 50 } },
         { creatorId: 'c1', _count: { ownerAddress: 20 } },
      ]);

      const res = await getKeyDiscoveryLeaderboard('holders', 10);

      expect(res).toHaveLength(2);
      expect(res[0].rank).toBe(1);
      expect(res[0].key_id).toBe('c2');
      expect(res[0].metric_value).toBe('50');

      expect(res[1].rank).toBe(2);
      expect(res[1].key_id).toBe('c1');
      expect(res[1].metric_value).toBe('20');
   });

   it('ranks keys correctly by reputation score', async () => {
      prismaMock.creatorProfile.findMany.mockResolvedValueOnce([
         { id: 'c1', displayName: 'Creator One', handle: 'c_one' },
         { id: 'c2', displayName: 'Creator Two', handle: 'c_two' },
      ]);

      prismaMock.creatorReputation.findMany.mockResolvedValueOnce([
         { creatorId: 'c1', currentScore: 850 },
         { creatorId: 'c2', currentScore: 920 },
      ]);

      const res = await getKeyDiscoveryLeaderboard('reputation', 10);

      expect(res).toHaveLength(2);
      expect(res[0].rank).toBe(1);
      expect(res[0].key_id).toBe('c2');
      expect(res[0].metric_value).toBe('920');

      expect(res[1].rank).toBe(2);
      expect(res[1].key_id).toBe('c1');
      expect(res[1].metric_value).toBe('850');
   });

   it('enforces maximum limit of 100 entries', async () => {
      // Mock 120 creators
      const dummyCreators = Array.from({ length: 120 }, (_, i) => ({
         id: `c${i}`,
         displayName: `Creator ${i}`,
         handle: `handle_${i}`,
      }));
      prismaMock.creatorProfile.findMany.mockResolvedValueOnce(dummyCreators);
      prismaMock.trade.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      const res = await getKeyDiscoveryLeaderboard('volume', 200);

      expect(res.length).toBeLessThanOrEqual(100);
   });

   it('returns cached results when available', async () => {
      const cached = [
         {
            rank: 1,
            key_id: 'c-cached',
            key_name: 'Cached Key',
            creator: 'cached_creator',
            metric_value: '9999',
            '24h_change': '+10%',
         },
      ];
      cacheStore.set('analytics:keys:leaderboard:volume:50', cached);

      const res = await getKeyDiscoveryLeaderboard('volume', 50);

      expect(res).toEqual(cached);
      expect(prismaMock.creatorProfile.findMany).not.toHaveBeenCalled();
   });

   it('invalidates cache correctly', async () => {
      cacheStore.set('analytics:keys:leaderboard:volume:50', true);

      await invalidateDiscoveryLeaderboardCache();

      expect(cacheStore.has('analytics:keys:leaderboard:volume:50')).toBe(false);
   });
});
