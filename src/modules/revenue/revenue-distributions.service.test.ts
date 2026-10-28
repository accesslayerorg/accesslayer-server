import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';
import {
   getRevenueDistributions,
   getWalletRevenueDistributions,
   REVENUE_DISTRIBUTIONS_CACHE_TTL_SECONDS,
} from './revenue-distributions.service';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: { revenueDistribution: { findMany: jest.fn() } },
}));

jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn(),
   cacheSetJson: jest.fn(),
}));

const mockPrisma = prisma as unknown as {
   revenueDistribution: { findMany: jest.Mock };
};
const mockCacheGet = cacheGetJson as jest.Mock;
const mockCacheSet = cacheSetJson as jest.Mock;

describe('revenue distribution read service', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      mockCacheGet.mockResolvedValue(null);
      mockCacheSet.mockResolvedValue(undefined);
   });

   it('returns paginated distributions and caches them for 60 seconds', async () => {
      mockPrisma.revenueDistribution.findMany.mockResolvedValue([
         {
            id: 'dist-db-1',
            chainDistributionId: 'dist-chain-1',
            distributedAt: new Date('2026-10-20T10:00:00.000Z'),
            amount: 25,
            holderCount: 3,
         },
         {
            id: 'dist-db-2',
            chainDistributionId: null,
            distributedAt: new Date('2026-10-19T10:00:00.000Z'),
            amount: 20,
            holderCount: 2,
         },
      ]);

      const result = await getRevenueDistributions({
         keyId: 'key-1',
         limit: 1,
      });

      expect(result).toEqual({
         entries: [
            {
               distributionId: 'dist-chain-1',
               distributedAt: '2026-10-20T10:00:00.000Z',
               amount: 25,
               holderCount: 3,
            },
         ],
         pagination: {
            limit: 1,
            hasMore: true,
            nextCursor: 'dist-db-1',
         },
      });
      expect(mockCacheSet).toHaveBeenCalledWith(
         'key:revenue-distributions:key-1:list:1:',
         result,
         REVENUE_DISTRIBUTIONS_CACHE_TTL_SECONDS
      );
   });

   it('returns the wallet claimed and remaining claimable amount per distribution', async () => {
      mockPrisma.revenueDistribution.findMany.mockResolvedValue([
         {
            id: 'dist-db-1',
            chainDistributionId: 'dist-chain-1',
            distributedAt: new Date('2026-10-20T10:00:00.000Z'),
            amount: 25,
            holderCount: 3,
            shares: [{ amount: 10, claims: [{ amount: 3 }, { amount: 2 }] }],
         },
         {
            id: 'dist-db-2',
            chainDistributionId: null,
            distributedAt: new Date('2026-10-19T10:00:00.000Z'),
            amount: 20,
            holderCount: 2,
            shares: [],
         },
      ]);

      const result = await getWalletRevenueDistributions({
         keyId: 'key-1',
         wallet: 'GWALLET1',
      });

      expect(result).toEqual([
         {
            distributionId: 'dist-chain-1',
            distributedAt: '2026-10-20T10:00:00.000Z',
            amount: 25,
            holderCount: 3,
            claimableAmount: 5,
            claimedAmount: 5,
         },
         {
            distributionId: 'dist-db-2',
            distributedAt: '2026-10-19T10:00:00.000Z',
            amount: 20,
            holderCount: 2,
            claimableAmount: 0,
            claimedAmount: 0,
         },
      ]);
   });
});
