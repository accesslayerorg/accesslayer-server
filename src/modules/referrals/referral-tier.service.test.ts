// Unit tests: referral tier service + tier ladder (#1034)
//
// Covers the acceptance criteria:
//   - current tier + cumulative volume reported correctly
//   - next threshold distance computed correctly
//   - reward rate bps returned correctly per tier
//   - upgrades recorded without duplication and never downgraded
//   - tier snapshot cached for 5 minutes

const store = new Map<string, { value: unknown; ttl?: number }>();

jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn(async (key: string) => {
      const entry = store.get(key);
      return entry ? entry.value : null;
   }),
   cacheSetJson: jest.fn(async (key: string, value: unknown, ttl: number) => {
      store.set(key, { value, ttl });
   }),
   cacheInvalidate: jest.fn(async (...keys: string[]) => {
      for (const key of keys) store.delete(key);
   }),
}));

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      referralTier: {
         findUnique: jest.fn(),
         create: jest.fn(),
         update: jest.fn(),
      },
      referralTierEvent: {
         findMany: jest.fn(),
         upsert: jest.fn(),
      },
   },
}));

import { prisma } from '../../utils/prisma.utils';
import { encodeCursor } from '../../utils/cursor.utils';
import {
   buildReferralTierCacheKey,
   getNextReferralTier,
   getReferralTierDefinition,
   getReferralTierForVolume,
   REFERRAL_TIER_CACHE_TTL_SECONDS,
} from './referral-tier.constants';
import {
   buildReferralTierSnapshot,
   getReferralTierHistory,
   getReferralTierSnapshot,
   recordReferralTierUpgrade,
} from './referral-tier.service';

const tierFindUnique = prisma.referralTier.findUnique as jest.Mock;
const tierCreate = prisma.referralTier.create as jest.Mock;
const tierUpdate = prisma.referralTier.update as jest.Mock;
const eventFindMany = prisma.referralTierEvent.findMany as jest.Mock;
const eventUpsert = prisma.referralTierEvent.upsert as jest.Mock;

const WALLET = 'GA5XIGA5C7GTGTW7ZKJ4YV6OEILUY2Q7YIHZQNNDJUWAVES4O7D5SUK9';

describe('referral tier ladder', () => {
   it('derives the tier from cumulative volume thresholds', () => {
      expect(getReferralTierForVolume(0)).toBe(1);
      expect(getReferralTierForVolume(999)).toBe(1);
      expect(getReferralTierForVolume(1000)).toBe(2);
      expect(getReferralTierForVolume(9999)).toBe(2);
      expect(getReferralTierForVolume(10000)).toBe(3);
      expect(getReferralTierForVolume(50000)).toBe(3);
   });

   it('returns the reward rate in bps for each tier', () => {
      expect(getReferralTierDefinition(1).rewardRateBps).toBe(500);
      expect(getReferralTierDefinition(2).rewardRateBps).toBe(750);
      expect(getReferralTierDefinition(3).rewardRateBps).toBe(1000);
   });

   it('exposes the next tier threshold', () => {
      expect(getNextReferralTier(1)?.minVolume).toBe(1000);
      expect(getNextReferralTier(2)?.minVolume).toBe(10000);
      expect(getNextReferralTier(3)).toBeNull();
   });
});

describe('buildReferralTierSnapshot', () => {
   it('computes the distance to the next threshold', () => {
      const snapshot = buildReferralTierSnapshot(WALLET, 1, 250, null);
      expect(snapshot).toEqual({
         wallet: WALLET,
         tier: 1,
         cumulativeVolume: 250,
         nextThreshold: 1000,
         distanceToNextThreshold: 750,
         rewardRateBps: 500,
         updatedAt: null,
      });
   });

   it('returns null threshold/distance at the top tier', () => {
      const snapshot = buildReferralTierSnapshot(WALLET, 3, 12000, null);
      expect(snapshot.nextThreshold).toBeNull();
      expect(snapshot.distanceToNextThreshold).toBeNull();
      expect(snapshot.rewardRateBps).toBe(1000);
   });

   it('clamps the distance to zero once the next threshold is reached', () => {
      const snapshot = buildReferralTierSnapshot(WALLET, 1, 1500, null);
      expect(snapshot.nextThreshold).toBe(1000);
      expect(snapshot.distanceToNextThreshold).toBe(0);
   });
});

describe('getReferralTierSnapshot', () => {
   beforeEach(() => {
      store.clear();
      jest.clearAllMocks();
   });

   it('defaults to the entry tier for a wallet with no upgrades', async () => {
      tierFindUnique.mockResolvedValue(null);

      const snapshot = await getReferralTierSnapshot(WALLET);

      expect(snapshot.tier).toBe(1);
      expect(snapshot.cumulativeVolume).toBe(0);
      expect(snapshot.nextThreshold).toBe(1000);
      expect(snapshot.rewardRateBps).toBe(500);
   });

   it('returns the persisted tier and caches it for 5 minutes', async () => {
      tierFindUnique.mockResolvedValue({
         tier: 2,
         cumulativeVolume: '1500',
         lastUpgradedAt: new Date('2026-09-01T00:00:00.000Z'),
      });

      const snapshot = await getReferralTierSnapshot(WALLET);

      expect(snapshot.tier).toBe(2);
      expect(snapshot.cumulativeVolume).toBe(1500);
      expect(snapshot.nextThreshold).toBe(10000);
      expect(snapshot.distanceToNextThreshold).toBe(8500);
      expect(snapshot.rewardRateBps).toBe(750);
      expect(snapshot.updatedAt).toBe('2026-09-01T00:00:00.000Z');

      const entry = store.get(buildReferralTierCacheKey(WALLET));
      expect(entry?.ttl).toBe(REFERRAL_TIER_CACHE_TTL_SECONDS);
      expect(REFERRAL_TIER_CACHE_TTL_SECONDS).toBe(300);
   });

   it('serves a fresh snapshot from cache without hitting the database', async () => {
      store.set(buildReferralTierCacheKey(WALLET), {
         value: { tier: 3, cumulativeVolume: 20000, rewardRateBps: 1000 },
      });

      const snapshot = await getReferralTierSnapshot(WALLET);

      expect(snapshot.tier).toBe(3);
      expect(tierFindUnique).not.toHaveBeenCalled();
   });
});

describe('recordReferralTierUpgrade', () => {
   beforeEach(() => {
      store.clear();
      jest.clearAllMocks();
      eventUpsert.mockResolvedValue({});
   });

   const upgrade = {
      walletAddress: WALLET,
      previousTier: 1,
      newTier: 2,
      cumulativeVolume: 1500,
      txHash: 'tx-1',
      eventIndex: 0,
      ledger: 10,
      occurredAt: new Date('2026-09-01T00:00:00.000Z'),
   };

   it('writes the history row idempotently and invalidates the cache', async () => {
      tierFindUnique.mockResolvedValue(null);
      tierCreate.mockResolvedValue({});
      store.set(buildReferralTierCacheKey(WALLET), { value: { tier: 1 } });

      await recordReferralTierUpgrade(upgrade);

      expect(eventUpsert).toHaveBeenCalledWith(
         expect.objectContaining({
            where: { txHash_eventIndex: { txHash: 'tx-1', eventIndex: 0 } },
            update: {},
         })
      );
      expect(tierCreate).toHaveBeenCalledWith(
         expect.objectContaining({
            data: expect.objectContaining({
               walletAddress: WALLET,
               tier: 2,
               cumulativeVolume: 1500,
            }),
         })
      );
      expect(store.has(buildReferralTierCacheKey(WALLET))).toBe(false);
   });

   it('advances an existing lower tier', async () => {
      tierFindUnique.mockResolvedValue({ tier: 1, cumulativeVolume: '500' });
      tierUpdate.mockResolvedValue({});

      await recordReferralTierUpgrade(upgrade);

      expect(tierUpdate).toHaveBeenCalledWith({
         where: { walletAddress: WALLET },
         data: expect.objectContaining({ tier: 2, cumulativeVolume: 1500 }),
      });
   });

   it('never downgrades on an out-of-order replay', async () => {
      tierFindUnique.mockResolvedValue({ tier: 3, cumulativeVolume: '20000' });

      await recordReferralTierUpgrade(upgrade);

      expect(tierUpdate).not.toHaveBeenCalled();
      expect(tierCreate).not.toHaveBeenCalled();
   });
});

describe('getReferralTierHistory', () => {
   beforeEach(() => {
      store.clear();
      jest.clearAllMocks();
   });

   it('maps rows into upgrade items and paginates with a cursor', async () => {
      eventFindMany.mockResolvedValue([
         {
            id: 'e1',
            previousTier: 1,
            newTier: 2,
            cumulativeVolume: '1000',
            occurredAt: new Date('2026-09-02T00:00:00.000Z'),
            txHash: 'tx-b',
         },
         {
            id: 'e2',
            previousTier: 2,
            newTier: 3,
            cumulativeVolume: '10000',
            occurredAt: new Date('2026-09-01T00:00:00.000Z'),
            txHash: 'tx-a',
         },
      ]);

      const page = await getReferralTierHistory(WALLET, { limit: 1 });

      expect(page.items).toEqual([
         {
            id: 'e1',
            previousTier: 1,
            newTier: 2,
            cumulativeVolume: 1000,
            occurredAt: '2026-09-02T00:00:00.000Z',
            txHash: 'tx-b',
         },
      ]);
      expect(page.pagination.hasMore).toBe(true);
      expect(page.pagination.nextCursor).toBeDefined();
   });

   it('applies keyset filtering when a cursor is supplied', async () => {
      eventFindMany.mockResolvedValue([]);
      const cursor = encodeCursor({
         occurredAt: '2026-09-02T00:00:00.000Z',
         id: 'e1',
      });

      await getReferralTierHistory(WALLET, { limit: 20, cursor });

      expect(eventFindMany).toHaveBeenCalledWith(
         expect.objectContaining({
            where: {
               walletAddress: WALLET,
               AND: [
                  {
                     OR: [
                        {
                           occurredAt: {
                              lt: new Date('2026-09-02T00:00:00.000Z'),
                           },
                        },
                        {
                           occurredAt: new Date('2026-09-02T00:00:00.000Z'),
                           id: { lt: 'e1' },
                        },
                     ],
                  },
               ],
            },
         })
      );
   });
});
