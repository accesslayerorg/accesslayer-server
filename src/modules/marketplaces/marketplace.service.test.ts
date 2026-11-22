jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      approvedMarketplace: { findMany: jest.fn() },
      keyRoyaltyEnforcement: { findFirst: jest.fn() },
      creatorProfile: { findFirst: jest.fn() },
      registeredKey: { findFirst: jest.fn().mockResolvedValue(null) },
   },
}));
jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn().mockResolvedValue(null),
   cacheSetJson: jest.fn(),
}));

import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';
import { getApprovedMarketplaces, getRoyaltyEnforcement, MARKETPLACE_CACHE_KEY } from './marketplace.service';

describe('marketplace registry reads', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      (cacheGetJson as jest.Mock).mockResolvedValue(null);
      (prisma.creatorProfile.findFirst as jest.Mock).mockResolvedValue({ id: 'key-1' });
      (prisma.keyRoyaltyEnforcement.findFirst as jest.Mock).mockResolvedValue(null);
   });

   it('lists only approved marketplaces and caches approval dates for five minutes', async () => {
      const approvedAt = new Date('2026-11-21T12:00:00Z');
      (prisma.approvedMarketplace.findMany as jest.Mock).mockResolvedValue([
         { address: 'market-a', approvedAt },
      ]);
      const result = await getApprovedMarketplaces();
      expect(result).toEqual([{ address: 'market-a', approvedAt: approvedAt.toISOString() }]);
      expect(prisma.approvedMarketplace.findMany).toHaveBeenCalledWith({
         where: { approved: true }, orderBy: [{ approvedAt: 'desc' }, { address: 'asc' }],
         select: { address: true, approvedAt: true },
      });
      expect(cacheSetJson).toHaveBeenCalledWith(MARKETPLACE_CACHE_KEY, result, 300);
   });

   it('serves a cached registry without querying the database', async () => {
      (cacheGetJson as jest.Mock).mockResolvedValue([]);
      expect(await getApprovedMarketplaces()).toEqual([]);
      expect(prisma.approvedMarketplace.findMany).not.toHaveBeenCalled();
   });

   it('reads pre-registration handle projections through the canonical key', async () => {
      (prisma.creatorProfile.findFirst as jest.Mock).mockResolvedValue({ id: 'key-1', handle: 'creator-handle' });
      (prisma.keyRoyaltyEnforcement.findFirst as jest.Mock).mockResolvedValue({
         royaltyEnforced: true, locked: false,
      });
      expect(await getRoyaltyEnforcement('key-1')).toEqual({
         keyId: 'key-1', royaltyEnforced: true, locked: false,
      });
      expect(prisma.keyRoyaltyEnforcement.findFirst).toHaveBeenCalledWith({
         where: { keyId: { in: ['key-1', 'creator-handle'] } },
         orderBy: [
            { ledger: 'desc' },
            { transactionIndex: { sort: 'desc', nulls: 'last' } },
            { eventIndex: 'desc' },
         ],
      });
   });

   it('returns both enforcement and lock flags, defaulting an unset key to false', async () => {
      expect(await getRoyaltyEnforcement('key-1')).toEqual({
         keyId: 'key-1', royaltyEnforced: false, locked: false,
      });
      (prisma.keyRoyaltyEnforcement.findFirst as jest.Mock).mockResolvedValue({
         royaltyEnforced: true, locked: true,
      });
      expect(await getRoyaltyEnforcement('key-1')).toEqual({
         keyId: 'key-1', royaltyEnforced: true, locked: true,
      });
   });
});
