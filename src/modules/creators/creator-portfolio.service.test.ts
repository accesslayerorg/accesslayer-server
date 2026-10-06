const mockPrisma = {
   creatorProfile: { findMany: jest.fn() },
   keyOwnership: { count: jest.fn() },
   activity: { findMany: jest.fn() },
};
jest.mock('../../utils/prisma.utils', () => ({ prisma: mockPrisma }));

const mockCache = {
   cacheGetJson: jest.fn(),
   cacheSetJson: jest.fn(),
   cacheInvalidate: jest.fn(),
};
jest.mock('../../utils/redis.utils', () => mockCache);

jest.mock('../../utils/cursor.utils', () => ({
   encodeCursor: jest.fn((payload: unknown) => JSON.stringify(payload)),
   decodeCursor: jest.fn((cursor: string) => JSON.parse(cursor)),
}));

import {
   fetchCreatorPortfolioKeys,
   getCreatorPortfolioStats,
   invalidateCreatorPortfolioStatsCache,
} from './creator-portfolio.service';

describe('creator portfolio stats', () => {
   beforeEach(() => jest.clearAllMocks());

   it('aggregates keys, active holders, and buy/sell volume for the wallet', async () => {
      mockCache.cacheGetJson.mockResolvedValue(null);
      mockPrisma.creatorProfile.findMany.mockResolvedValue([
         { id: 'key-a' },
         { id: 'key-b' },
      ]);
      mockPrisma.keyOwnership.count.mockResolvedValue(4);
      mockPrisma.activity.findMany.mockResolvedValue([
         { payload: { amount: 2, price_at_trade: '100' } },
         { payload: { amount: 3, price_at_trade: '50' } },
      ]);

      await expect(getCreatorPortfolioStats('G-wallet')).resolves.toEqual({
         totalKeys: 2,
         totalHolders: 4,
         totalTradingVolume: '350',
      });

      expect(mockPrisma.keyOwnership.count).toHaveBeenCalledWith({
         where: { creatorId: { in: ['key-a', 'key-b'] }, balance: { gt: 0 } },
      });
      expect(mockCache.cacheSetJson).toHaveBeenCalledWith(
         'creator-portfolio:stats:v1:G-wallet',
         { totalKeys: 2, totalHolders: 4, totalTradingVolume: '350' },
         60
      );
   });

   it('serves cached stats without querying the database', async () => {
      const stats = {
         totalKeys: 1,
         totalHolders: 3,
         totalTradingVolume: '500',
      };
      mockCache.cacheGetJson.mockResolvedValue(stats);

      await expect(getCreatorPortfolioStats('G-wallet')).resolves.toEqual(
         stats
      );
      expect(mockPrisma.creatorProfile.findMany).not.toHaveBeenCalled();
   });

   it('invalidates the wallet-specific stats cache key', async () => {
      await invalidateCreatorPortfolioStatsCache('G-wallet');

      expect(mockCache.cacheInvalidate).toHaveBeenCalledWith(
         'creator-portfolio:stats:v1:G-wallet'
      );
   });
});

describe('creator portfolio key pagination', () => {
   beforeEach(() => jest.clearAllMocks());

   it('over-fetches one key and returns a cursor for the next page', async () => {
      const createdAt = new Date('2026-09-24T12:00:00.000Z');
      mockPrisma.creatorProfile.findMany.mockResolvedValue([
         { id: 'key-c', createdAt },
         { id: 'key-b', createdAt },
         { id: 'key-a', createdAt },
      ]);

      const page = await fetchCreatorPortfolioKeys('G-wallet', '2');

      expect(page.items).toHaveLength(2);
      expect(page.hasMore).toBe(true);
      expect(page.nextCursor).toBe(
         JSON.stringify({ id: 'key-b', createdAt: createdAt.toISOString() })
      );
      expect(mockPrisma.creatorProfile.findMany).toHaveBeenCalledWith(
         expect.objectContaining({
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 3,
         })
      );
   });

   it('applies the cursor boundary to the next query', async () => {
      mockPrisma.creatorProfile.findMany.mockResolvedValue([]);
      const createdAt = '2026-09-24T12:00:00.000Z';

      await fetchCreatorPortfolioKeys(
         'G-wallet',
         '2',
         JSON.stringify({ id: 'key-b', createdAt })
      );

      expect(mockPrisma.creatorProfile.findMany).toHaveBeenCalledWith(
         expect.objectContaining({
            where: expect.objectContaining({
               OR: [
                  { createdAt: { lt: new Date(createdAt) } },
                  { createdAt: new Date(createdAt), id: { lt: 'key-b' } },
               ],
            }),
         })
      );
   });

   it('rejects malformed cursors and out-of-range limits', async () => {
      await expect(
         fetchCreatorPortfolioKeys('G-wallet', '2', 'bad')
      ).rejects.toThrow('Invalid keys pagination cursor');
      await expect(
         fetchCreatorPortfolioKeys('G-wallet', '101')
      ).rejects.toThrow('Invalid keys pagination limit');
   });
});
