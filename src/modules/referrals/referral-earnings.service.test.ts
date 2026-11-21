// Unit tests: referral earnings service + persistence (#1057)
//
// Covers the acceptance criteria:
//   - earnings list maps tier/amount/source wallet/date
//   - cursor pagination returns a stable next cursor
//   - date range filter narrows the query
//   - summary returns accurate totals and tier 1/2/3 breakdown
//   - reward persistence is idempotent (upsert) and busts the cached summary

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
      referralEarning: {
         findMany: jest.fn(),
         aggregate: jest.fn(),
         groupBy: jest.fn(),
         upsert: jest.fn(),
      },
   },
}));

import { prisma } from '../../utils/prisma.utils';
import { cacheInvalidate } from '../../utils/redis.utils';
import { encodeCursor } from '../../utils/cursor.utils';
import {
   getReferralEarnings,
   getReferralEarningsSummary,
   recordReferralEarning,
} from './referral-earnings.service';
import { buildReferralEarningsSummaryCacheKey } from './referral-earnings.constants';

const findMany = prisma.referralEarning.findMany as jest.Mock;
const aggregate = prisma.referralEarning.aggregate as jest.Mock;
const groupBy = prisma.referralEarning.groupBy as jest.Mock;
const upsert = prisma.referralEarning.upsert as jest.Mock;
const invalidate = cacheInvalidate as jest.Mock;

const WALLET = 'GA5XIGA5C7GTGTW7ZKJ4YV6OEILUY2Q7YIHZQNNDJUWAVES4O7D5SUK9';

function row(overrides: Record<string, unknown> = {}) {
   return {
      id: 'earning-1',
      referrerWallet: WALLET,
      sourceWallet: 'GSOURCEWALLET1',
      tier: 1,
      amount: '12.5',
      txHash: 'tx-1',
      eventIndex: 0,
      ledger: 100,
      earnedAt: new Date('2026-08-20T10:00:00.000Z'),
      ...overrides,
   };
}

describe('getReferralEarnings', () => {
   beforeEach(() => jest.clearAllMocks());

   it('maps rows into tier/amount/source/date items', async () => {
      findMany.mockResolvedValue([row()]);

      const page = await getReferralEarnings({ wallet: WALLET, limit: 20 });

      expect(page.items).toEqual([
         {
            id: 'earning-1',
            tier: 1,
            amount: 12.5,
            sourceWallet: 'GSOURCEWALLET1',
            earnedAt: '2026-08-20T10:00:00.000Z',
            txHash: 'tx-1',
         },
      ]);
      expect(page.pagination.hasMore).toBe(false);
      expect(page.pagination.nextCursor).toBeUndefined();
   });

   it('returns a next cursor when a full page is returned', async () => {
      findMany.mockResolvedValue([
         row(),
         row({ id: 'earning-2', earnedAt: new Date('2026-08-19T10:00:00.000Z') }),
      ]);

      const page = await getReferralEarnings({ wallet: WALLET, limit: 1 });

      expect(page.items).toHaveLength(1);
      expect(page.pagination.hasMore).toBe(true);
      expect(page.pagination.nextCursor).toBeDefined();
   });

   it('applies the from/to date range as an inclusive filter', async () => {
      findMany.mockResolvedValue([]);

      await getReferralEarnings({
         wallet: WALLET,
         limit: 20,
         from: '2026-08-01',
         to: '2026-08-31T23:59:59.000Z',
      });

      expect(findMany).toHaveBeenCalledWith(
         expect.objectContaining({
            where: {
               referrerWallet: WALLET,
               earnedAt: {
                  gte: new Date('2026-08-01'),
                  lte: new Date('2026-08-31T23:59:59.000Z'),
               },
            },
         })
      );
   });

   it('applies keyset filtering when a cursor is supplied', async () => {
      findMany.mockResolvedValue([]);
      const cursor = encodeCursor({
         earnedAt: '2026-08-20T10:00:00.000Z',
         id: 'earning-1',
      });

      await getReferralEarnings({ wallet: WALLET, limit: 20, cursor });

      expect(findMany).toHaveBeenCalledWith(
         expect.objectContaining({
            where: {
               referrerWallet: WALLET,
               AND: [
                  {
                     OR: [
                        { earnedAt: { lt: new Date('2026-08-20T10:00:00.000Z') } },
                        {
                           earnedAt: new Date('2026-08-20T10:00:00.000Z'),
                           id: { lt: 'earning-1' },
                        },
                     ],
                  },
               ],
            },
         })
      );
   });
});

describe('getReferralEarningsSummary', () => {
   beforeEach(() => {
      store.clear();
      jest.clearAllMocks();
   });

   it('returns totals and the tier 1/2/3 breakdown', async () => {
      aggregate.mockResolvedValue({
         _sum: { amount: '60' },
         _count: { _all: 4 },
      });
      groupBy.mockResolvedValueOnce([
         { tier: 1, _sum: { amount: '30' } },
         { tier: 2, _sum: { amount: '20' } },
         { tier: 3, _sum: { amount: '10' } },
      ]);
      findMany.mockResolvedValue([
         { sourceWallet: 'GSOURCEA' },
         { sourceWallet: 'GSOURCEB' },
      ]);

      const summary = await getReferralEarningsSummary(WALLET);

      expect(summary).toEqual({
         totalEarnings: 60,
         earningsCount: 4,
         referredWalletCount: 2,
         tiers: { tier1: 30, tier2: 20, tier3: 10 },
      });
   });

   it('caches the summary with a 2-minute TTL', async () => {
      aggregate.mockResolvedValue({ _sum: { amount: '5' }, _count: { _all: 1 } });
      groupBy.mockResolvedValueOnce([{ tier: 1, _sum: { amount: '5' } }]);
      findMany.mockResolvedValue([{ sourceWallet: 'GSOURCEA' }]);

      await getReferralEarningsSummary(WALLET);

      const entry = store.get(buildReferralEarningsSummaryCacheKey(WALLET));
      expect(entry).toBeDefined();
      expect(entry?.ttl).toBe(120);
   });

   it('serves a fresh summary from cache without re-aggregating', async () => {
      store.set(buildReferralEarningsSummaryCacheKey(WALLET), {
         value: {
            totalEarnings: 99,
            earningsCount: 9,
            referredWalletCount: 3,
            tiers: { tier1: 99, tier2: 0, tier3: 0 },
         },
      });

      const summary = await getReferralEarningsSummary(WALLET);

      expect(summary.totalEarnings).toBe(99);
      expect(aggregate).not.toHaveBeenCalled();
   });
});

describe('recordReferralEarning', () => {
   beforeEach(() => {
      store.clear();
      jest.clearAllMocks();
   });

   it('upserts by (txHash, eventIndex) and invalidates the cached summary', async () => {
      upsert.mockResolvedValue({});
      store.set(buildReferralEarningsSummaryCacheKey(WALLET), {
         value: { totalEarnings: 1 },
      });

      await recordReferralEarning({
         referrerWallet: WALLET,
         sourceWallet: 'GSOURCEWALLET1',
         tier: 2,
         amount: 3.25,
         txHash: 'tx-42',
         eventIndex: 1,
         ledger: 500,
         earnedAt: new Date('2026-08-20T10:00:00.000Z'),
      });

      expect(upsert).toHaveBeenCalledWith(
         expect.objectContaining({
            where: {
               txHash_eventIndex: { txHash: 'tx-42', eventIndex: 1 },
            },
            create: expect.objectContaining({
               referrerWallet: WALLET,
               sourceWallet: 'GSOURCEWALLET1',
               tier: 2,
            }),
         })
      );
      expect(invalidate).toHaveBeenCalledWith(
         buildReferralEarningsSummaryCacheKey(WALLET),
         expect.stringContaining(WALLET.toLowerCase())
      );
   });
});
