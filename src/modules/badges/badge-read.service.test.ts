import {
   getWalletBadgeCollection,
   getWalletBadgeSummary,
   WALLET_BADGES_CACHE_TTL_SECONDS,
} from './badge-read.service';
import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';

jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn().mockResolvedValue(null),
   cacheSetJson: jest.fn().mockResolvedValue(undefined),
   cacheInvalidate: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      walletBadge: {
         findMany: jest.fn(),
         groupBy: jest.fn(),
      },
   },
}));

const wallet = `G${'A'.repeat(55)}`;

beforeEach(() => {
   jest.clearAllMocks();
   (cacheGetJson as jest.Mock).mockResolvedValue(null);
   (cacheSetJson as jest.Mock).mockResolvedValue(undefined);
});

describe('wallet badge read models', () => {
   it('returns earned badges and computes all unearned types as locked', async () => {
      (prisma.walletBadge.findMany as jest.Mock).mockResolvedValue([
         {
            badgeType: 'FIRST_BUYER',
            mintedAt: new Date('2026-10-20T12:00:00.000Z'),
         },
         {
            badgeType: 'TOP_TRADER',
            mintedAt: new Date('2026-10-21T12:00:00.000Z'),
         },
      ]);

      const result = await getWalletBadgeCollection(wallet);

      expect(result.earned).toEqual([
         {
            type: 'FIRST_BUYER',
            name: 'First Buyer',
            mintedAt: '2026-10-20T12:00:00.000Z',
         },
         {
            type: 'TOP_TRADER',
            name: 'Top Trader',
            mintedAt: '2026-10-21T12:00:00.000Z',
         },
      ]);
      expect(result.locked.map(badge => badge.type)).toEqual([
         'WHALE_HOLDER',
         'GOVERNANCE_VOTER',
         'DIAMOND_HANDS',
      ]);
      expect(result.earned.length + result.locked.length).toBe(5);
      expect(result.totalEarned).toBe(2);
      expect(cacheSetJson).toHaveBeenCalledWith(
         `wallet-badges:v1:${wallet}:collection`,
         result,
         WALLET_BADGES_CACHE_TTL_SECONDS
      );
   });

   it('includes a count for each badge type, including zero-count types', async () => {
      (prisma.walletBadge.groupBy as jest.Mock).mockResolvedValue([
         { badgeType: 'FIRST_BUYER', _count: { _all: 2 } },
         { badgeType: 'TOP_TRADER', _count: { _all: 1 } },
      ]);

      const result = await getWalletBadgeSummary(wallet);

      expect(result.totalEarned).toBe(3);
      expect(result.byType).toHaveLength(5);
      expect(result.byType.map(badge => badge.count)).toEqual([2, 0, 0, 0, 1]);
      expect(cacheSetJson).toHaveBeenCalledWith(
         `wallet-badges:v1:${wallet}:summary`,
         result,
         WALLET_BADGES_CACHE_TTL_SECONDS
      );
   });

   it('serves cached collection data without querying the database', async () => {
      const cached = { earned: [], locked: [], totalEarned: 0 };
      (cacheGetJson as jest.Mock).mockResolvedValue(cached);

      await expect(getWalletBadgeCollection(wallet)).resolves.toBe(cached);
      expect(prisma.walletBadge.findMany).not.toHaveBeenCalled();
   });
});
