const redisStore = new Map<string, { value: string; ttl: number }>();

jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn(async (key: string) => {
      const entry = redisStore.get(key);
      if (!entry) return null;
      try {
         return JSON.parse(entry.value);
      } catch {
         return null;
      }
   }),
   cacheSetJson: jest.fn(async (key: string, value: unknown, ttl: number) => {
      redisStore.set(key, { value: JSON.stringify(value), ttl });
   }),
   cacheInvalidate: jest.fn(async (...keys: string[]) => {
      for (const key of keys) redisStore.delete(key);
   }),
}));

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      creatorProfile: {
         findFirst: jest.fn(),
         findMany: jest.fn(),
      },
      activity: {
         findFirst: jest.fn(),
      },
      activityLog: {
         findFirst: jest.fn(),
      },
      keyOwnership: {
         findUnique: jest.fn(),
         findMany: jest.fn(),
      },
      milestoneClaim: {
         findMany: jest.fn(),
      },
   },
}));

import { prisma } from '../../utils/prisma.utils';
import {
   getKeyHolderMilestones,
   getWalletAllMilestones,
   getFirstPurchaseTimestamp,
   invalidateHolderMilestonesCache,
   KeyNotFoundError,
} from './holder-milestones.service';
import { cacheSetJson, cacheInvalidate } from '../../utils/redis.utils';
import { HOLDER_MILESTONES_CACHE_TTL_SECONDS } from '../../constants/notifications.constants';

describe('holder-milestones.service', () => {
   beforeEach(() => {
      redisStore.clear();
      jest.clearAllMocks();
   });

   describe('getFirstPurchaseTimestamp', () => {
      it('returns Activity createdAt if present', async () => {
         const firstBuy = new Date('2026-08-01T00:00:00Z');
         (prisma.activity.findFirst as jest.Mock).mockResolvedValue({ createdAt: firstBuy });

         const result = await getFirstPurchaseTimestamp('key-1', 'wallet-1');
         expect(result).toEqual(firstBuy);
      });

      it('falls back to ActivityLog timestamp if Activity is missing', async () => {
         const firstBuy = new Date('2026-08-10T00:00:00Z');
         (prisma.activity.findFirst as jest.Mock).mockResolvedValue(null);
         (prisma.activityLog.findFirst as jest.Mock).mockResolvedValue({ timestamp: firstBuy });

         const result = await getFirstPurchaseTimestamp('key-1', 'wallet-1');
         expect(result).toEqual(firstBuy);
      });

      it('falls back to KeyOwnership createdAt if Activity and ActivityLog are missing', async () => {
         const firstBuy = new Date('2026-08-20T00:00:00Z');
         (prisma.activity.findFirst as jest.Mock).mockResolvedValue(null);
         (prisma.activityLog.findFirst as jest.Mock).mockResolvedValue(null);
         (prisma.keyOwnership.findUnique as jest.Mock).mockResolvedValue({ createdAt: firstBuy });

         const result = await getFirstPurchaseTimestamp('key-1', 'wallet-1');
         expect(result).toEqual(firstBuy);
      });
   });

   describe('getKeyHolderMilestones', () => {
      it('throws KeyNotFoundError for unknown key', async () => {
         (prisma.creatorProfile.findFirst as jest.Mock).mockResolvedValue(null);

         await expect(getKeyHolderMilestones('unknown-key', 'wallet-1')).rejects.toBeInstanceOf(
            KeyNotFoundError
         );
      });

      it('computes days_held, accurately determines milestone eligibility, and caches 60s', async () => {
         (prisma.creatorProfile.findFirst as jest.Mock).mockResolvedValue({ id: 'key-1' });

         // Bought 40 days ago
         const purchaseDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
         (prisma.activity.findFirst as jest.Mock).mockResolvedValue({ createdAt: purchaseDate });

         // Tier 1 (7d) already claimed
         (prisma as any).milestoneClaim.findMany.mockResolvedValue([
            {
               keyId: 'key-1',
               wallet: 'wallet-1',
               milestoneId: 'holding_7d',
               tier: 1,
               claimedAt: new Date(purchaseDate.getTime() + 8 * 86400000),
            },
         ]);

         const result = await getKeyHolderMilestones('key-1', 'wallet-1');

         expect(result.key_id).toBe('key-1');
         expect(result.wallet).toBe('wallet-1');
         expect(result.days_held).toBe(40);

         // Tier 1 (7d): claimed
         expect(result.milestones[0].claimed).toBe(true);
         expect(result.milestones[0].days_remaining).toBe(0);

         // Tier 2 (30d): not claimed, but daysHeld(40) >= 30, so eligible_now = true
         expect(result.milestones[1].claimed).toBe(false);
         expect(result.milestones[1].days_remaining).toBe(0);

         // Next eligible milestone should be Tier 2
         expect(result.next_eligible_milestone).toEqual({
            tier: 2,
            milestone_id: 'holding_30d',
            required_days: 30,
            days_remaining: 0,
            eligible_now: true,
         });

         // Tier 3 (90d): not claimed, 50 days remaining
         expect(result.milestones[2].claimed).toBe(false);
         expect(result.milestones[2].days_remaining).toBe(50);

         expect(cacheSetJson).toHaveBeenCalledWith(
            expect.stringContaining('holder_milestones:key-1:wallet-1'),
            expect.any(Object),
            HOLDER_MILESTONES_CACHE_TTL_SECONDS
         );
      });

      it('serves from Redis cache on repeated calls', async () => {
         (prisma.creatorProfile.findFirst as jest.Mock).mockResolvedValue({ id: 'key-1' });
         (prisma.activity.findFirst as jest.Mock).mockResolvedValue({ createdAt: new Date() });
         (prisma as any).milestoneClaim.findMany.mockResolvedValue([]);

         await getKeyHolderMilestones('key-1', 'wallet-1');
         expect(prisma.creatorProfile.findFirst).toHaveBeenCalledTimes(1);

         const cached = await getKeyHolderMilestones('key-1', 'wallet-1');
         expect(cached.key_id).toBe('key-1');
         expect(prisma.creatorProfile.findFirst).toHaveBeenCalledTimes(1);
      });
   });

   describe('getWalletAllMilestones', () => {
      it('returns empty holdings when wallet owns 0 keys', async () => {
         (prisma.keyOwnership.findMany as jest.Mock).mockResolvedValue([]);

         const result = await getWalletAllMilestones('wallet-empty');
         expect(result.wallet).toBe('wallet-empty');
         expect(result.holdings).toEqual([]);
      });

      it('returns cross-key holdings milestone status', async () => {
         const now = Date.now();
         const purchaseDate1 = new Date(now - 10 * 86400000);
         const purchaseDate2 = new Date(now - 100 * 86400000);

         (prisma.keyOwnership.findMany as jest.Mock).mockResolvedValue([
            { creatorId: 'key-1', balance: '5.0', createdAt: purchaseDate1 },
            { creatorId: 'key-2', balance: '12.0', createdAt: purchaseDate2 },
         ]);

         (prisma.creatorProfile.findMany as jest.Mock).mockResolvedValue([
            { id: 'key-1', handle: 'alice' },
            { id: 'key-2', handle: 'bob' },
         ]);

         (prisma as any).milestoneClaim.findMany.mockResolvedValue([
            { keyId: 'key-2', milestoneId: 'holding_7d', tier: 1 },
            { keyId: 'key-2', milestoneId: 'holding_30d', tier: 2 },
         ]);

         (prisma.activity.findFirst as jest.Mock).mockImplementation(async ({ where }) => {
            if (where.creatorId === 'key-1') return { createdAt: purchaseDate1 };
            if (where.creatorId === 'key-2') return { createdAt: purchaseDate2 };
            return null;
         });

         const result = await getWalletAllMilestones('wallet-user');
         expect(result.wallet).toBe('wallet-user');
         expect(result.holdings).toHaveLength(2);

         const h1 = result.holdings.find(h => h.key_id === 'key-1');
         expect(h1?.creator_handle).toBe('alice');
         expect(h1?.days_held).toBe(10);
         expect(h1?.next_eligible_milestone?.milestone_id).toBe('holding_7d');

         const h2 = result.holdings.find(h => h.key_id === 'key-2');
         expect(h2?.creator_handle).toBe('bob');
         expect(h2?.days_held).toBe(100);
         expect(h2?.claimed_milestones).toContain('holding_7d');
         expect(h2?.claimed_milestones).toContain('holding_30d');
         expect(h2?.next_eligible_milestone?.milestone_id).toBe('holding_90d');

         expect(cacheSetJson).toHaveBeenCalledWith(
            expect.stringContaining('holder_milestones:wallet:wallet-user'),
            expect.any(Object),
            HOLDER_MILESTONES_CACHE_TTL_SECONDS
         );
      });
   });

   describe('invalidateHolderMilestonesCache', () => {
      it('invalidates both per-key and wallet cache entries', async () => {
         await invalidateHolderMilestonesCache('key-1', 'wallet-1');
         expect(cacheInvalidate).toHaveBeenCalledWith(
            expect.stringContaining('holder_milestones:key-1:wallet-1')
         );
         expect(cacheInvalidate).toHaveBeenCalledWith(
            expect.stringContaining('holder_milestones:wallet:wallet-1')
         );
      });
   });
});
