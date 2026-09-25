// Unit tests: referral earnings endpoint (Feature: GET /users/:wallet/referrals)
//
// Covers the acceptance criteria:
//   - totalEarned and referralCount aggregated correctly
//   - breakdown paginated with a signed cursor
//   - summary cached in Redis with 2-minute TTL and served within TTL
//   - cache invalidated when a referral_fee_paid event arrives

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
   cacheGetRaw: jest.fn(async () => null),
   cacheSetRaw: jest.fn(async () => undefined),
}));

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      referralEvent: {
         aggregate: jest.fn(),
         findMany: jest.fn(),
         create: jest.fn(),
      },
      creatorProfile: { findMany: jest.fn() },
   },
}));

import { prisma } from '../../utils/prisma.utils';
import {
   handleReferralFeePaidEvent,
   httpGetWalletReferrals,
} from './referrals.controller';
import { buildReferralSummaryCacheKey } from './referrals.constants';
import { getReferralBreakdown, getReferralSummary } from './referrals.service';
import { encodeCursor } from '../../utils/cursor.utils';

const aggregate = prisma.referralEvent.aggregate as jest.Mock;
const findMany = prisma.referralEvent.findMany as jest.Mock;
const create = prisma.referralEvent.create as jest.Mock;
const creatorFindMany = prisma.creatorProfile.findMany as jest.Mock;

const WALLET = 'GA5XIGA5C7GTGTW7ZKJ4YV6OEILUY2Q7YIHZQNNDJUWAVES4O7D5SUK9';

function makeReq(overrides: Record<string, unknown> = {}): any {
   return { params: { wallet: WALLET }, query: {}, ...overrides };
}

function makeRes() {
   const res: any = {};
   res.statusCode = 200;
   res.headersSent = false;
   res.status = jest.fn().mockImplementation((code: number) => {
      res.statusCode = code;
      return res;
   });
   res.json = jest.fn().mockReturnValue(res);
   res.setHeader = jest.fn().mockReturnValue(res);
   res.set = jest.fn().mockReturnValue(res);
   return res;
}

describe('referrals.service', () => {
   beforeEach(() => {
      store.clear();
      jest.clearAllMocks();
   });

   describe('getReferralSummary', () => {
      it('aggregates totalEarned and referralCount', async () => {
         aggregate.mockResolvedValue({
            _sum: { amount: '12.5' },
            _count: { _all: 3 },
         });

         const summary = await getReferralSummary(WALLET);

         expect(summary).toEqual({ totalEarned: 12.5, referralCount: 3 });
         expect(aggregate).toHaveBeenCalledWith({
            where: { walletAddress: WALLET },
            _sum: { amount: true },
            _count: { _all: true },
         });
      });

      it('returns zeros when the wallet has no referrals', async () => {
         aggregate.mockResolvedValue({
            _sum: { amount: null },
            _count: { _all: 0 },
         });

         const summary = await getReferralSummary(WALLET);

         expect(summary).toEqual({ totalEarned: 0, referralCount: 0 });
      });
   });

   describe('getReferralBreakdown', () => {
      it('maps rows into (keyId, creatorName, amount, timestamp) items with a next cursor', async () => {
         const rowDate = new Date('2026-08-20T10:00:00.000Z');
         findMany.mockResolvedValue([
            {
               id: 'evt-1',
               keyId: 'key-1',
               creatorId: 'creator-1',
               amount: '5',
               createdAt: rowDate,
            },
         ]);
         creatorFindMany.mockResolvedValue([
            { id: 'creator-1', handle: 'alice', displayName: 'Alice' },
         ]);

         const page = await getReferralBreakdown(WALLET, { limit: 1 });

         expect(page.items).toEqual([
            {
               keyId: 'key-1',
               creatorName: 'Alice',
               amount: 5,
               timestamp: rowDate.toISOString(),
            },
         ]);
         // Full page → assume more rows exist.
         expect(page.nextCursor).not.toBeNull();
      });

      it('returns a null nextCursor for a partial final page', async () => {
         findMany.mockResolvedValue([]);
         creatorFindMany.mockResolvedValue([]);

         const page = await getReferralBreakdown(WALLET, { limit: 20 });

         expect(page.items).toEqual([]);
         expect(page.nextCursor).toBeNull();
      });

      it('applies keyset filtering when a cursor is supplied', async () => {
         findMany.mockResolvedValue([]);

         const cursor = encodeCursor({
            createdAt: '2026-08-20T10:00:00.000Z',
            id: 'evt-1',
         });
         await getReferralBreakdown(WALLET, { limit: 20, cursor });

         expect(findMany).toHaveBeenCalledWith(
            expect.objectContaining({
               where: {
                  walletAddress: WALLET,
                  OR: [
                     {
                        createdAt: { lt: new Date('2026-08-20T10:00:00.000Z') },
                     },
                     {
                        createdAt: {
                           lte: new Date('2026-08-20T10:00:00.000Z'),
                        },
                        id: { lt: 'evt-1' },
                     },
                  ],
               },
            })
         );
      });
   });
});

describe('httpGetWalletReferrals controller', () => {
   beforeEach(() => {
      store.clear();
      jest.clearAllMocks();
   });

   it('serves the summary from Redis within TTL without re-aggregating', async () => {
      // Prime the cache.
      store.set(buildReferralSummaryCacheKey(WALLET), {
         value: { totalEarned: 42, referralCount: 7 },
      });
      aggregate.mockResolvedValue({
         _sum: { amount: '999' },
         _count: { _all: 100 },
      });
      findMany.mockResolvedValue([]);

      const res = makeRes();
      await httpGetWalletReferrals(makeReq(), res);

      expect(res.status).toHaveBeenCalledWith(200);
      const body = res.json.mock.calls[0][0];
      expect(body.data.totalEarned).toBe(42);
      expect(body.data.referralCount).toBe(7);

      // Aggregate must not run while the cached summary is fresh.
      expect(aggregate).not.toHaveBeenCalled();
   });

   it('caches a freshly computed summary with a 2-minute TTL', async () => {
      aggregate.mockResolvedValue({
         _sum: { amount: '9' },
         _count: { _all: 2 },
      });
      findMany.mockResolvedValue([]);

      await httpGetWalletReferrals(makeReq(), makeRes());

      const entry = store.get(buildReferralSummaryCacheKey(WALLET));
      expect(entry).toBeDefined();
      expect(entry?.ttl).toBe(120);
   });

   it('rejects an invalid cursor with a validation error', async () => {
      aggregate.mockResolvedValue({
         _sum: { amount: null },
         _count: { _all: 0 },
      });
      findMany.mockResolvedValue([]);

      const res = makeRes();
      await httpGetWalletReferrals(
         makeReq({ query: { cursor: 'tampered.cursor' } }),
         res
      );

      expect(res.status).toHaveBeenCalledWith(400);
   });
});

describe('handleReferralFeePaidEvent', () => {
   beforeEach(() => {
      store.clear();
      jest.clearAllMocks();
   });

   it('persists the event and invalidates the cached summary', async () => {
      store.set(buildReferralSummaryCacheKey(WALLET), {
         value: { totalEarned: 1, referralCount: 1 },
      });
      create.mockResolvedValue({});

      await handleReferralFeePaidEvent({
         walletAddress: WALLET,
         keyId: 'key-9',
         amount: 2.5,
      });

      expect(create).toHaveBeenCalledWith(
         expect.objectContaining({
            data: expect.objectContaining({
               walletAddress: WALLET,
               keyId: 'key-9',
            }),
         })
      );
      expect(store.has(buildReferralSummaryCacheKey(WALLET))).toBe(false);
   });
});
