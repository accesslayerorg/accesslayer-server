// Unit tests for referral hold review (#1241): release pays every withheld
// reward exactly once, rejected and already-resolved holds never pay, and the
// withheld rewards stay unpaid until then.

jest.mock('../../utils/prisma.utils', () => {
   const referralHold = {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
      findMany: jest.fn(),
   };
   const referralHoldReward = { findMany: jest.fn(), groupBy: jest.fn() };
   const referralEvent = { createMany: jest.fn() };
   return {
      prisma: {
         referralHold,
         referralHoldReward,
         referralEvent,
         $transaction: jest.fn((cb: (tx: unknown) => unknown) =>
            cb({ referralHold, referralHoldReward, referralEvent })
         ),
      },
   };
});

import { prisma } from '../../utils/prisma.utils';
import { CursorChecksumError, encodeCursor } from '../../utils/cursor.utils';
import {
   listReferralHolds,
   ReferralHoldAlreadyResolvedError,
   ReferralHoldNotFoundError,
   resolveReferralHold,
} from './referral-hold.service';

const holdFindUnique = prisma.referralHold.findUnique as jest.Mock;
const holdUpdateMany = prisma.referralHold.updateMany as jest.Mock;
const holdFindMany = prisma.referralHold.findMany as jest.Mock;
const rewardFindMany = prisma.referralHoldReward.findMany as jest.Mock;
const rewardGroupBy = prisma.referralHoldReward.groupBy as jest.Mock;
const eventCreateMany = prisma.referralEvent.createMany as jest.Mock;

function holdRow(overrides: Record<string, unknown> = {}) {
   return {
      id: 'hold-1',
      referralId: 'ref-1',
      reason: 'FUNDING_CLUSTER',
      status: 'PENDING',
      details: { funder: 'GFUNDER' },
      referrerAddress: 'GREFERRER',
      refereeAddress: 'GREFEREE',
      resolvedBy: null,
      resolvedAt: null,
      createdAt: new Date('2026-11-05T12:00:01.000Z'),
      ...overrides,
   };
}

function rewardRow(overrides: Record<string, unknown> = {}) {
   return {
      id: 'rw-1',
      holdId: 'hold-1',
      keyId: 'key-1',
      rewardXlm: 0.025,
      tierMultiplier: 1,
      txHash: 'tx-1',
      eventIndex: 0,
      tradedAt: new Date('2026-11-05T12:00:00.000Z'),
      ...overrides,
   };
}

/**
 * Tiny stateful stand-in for the hold row so the "status guard" behaves like
 * the database: only the first PENDING -> X update succeeds.
 */
function useStatefulHold(initial = holdRow()) {
   let row = { ...initial };
   holdFindUnique.mockImplementation(async () => ({ ...row }));
   holdUpdateMany.mockImplementation(
      async ({ where, data }: { where: { status: string }; data: object }) => {
         if (row.status !== where.status) return { count: 0 };
         row = { ...row, ...data };
         return { count: 1 };
      }
   );
   return () => row;
}

beforeEach(() => {
   jest.resetAllMocks();
   (prisma.$transaction as jest.Mock).mockImplementation(
      (cb: (tx: unknown) => unknown) =>
         cb({
            referralHold: prisma.referralHold,
            referralHoldReward: prisma.referralHoldReward,
            referralEvent: prisma.referralEvent,
         })
   );
   rewardFindMany.mockResolvedValue([]);
   rewardGroupBy.mockResolvedValue([]);
});

describe('resolveReferralHold: release', () => {
   it('pays every withheld reward to the referrer and marks the hold RELEASED', async () => {
      const current = useStatefulHold();
      rewardFindMany.mockResolvedValue([
         rewardRow(),
         rewardRow({
            id: 'rw-2',
            keyId: 'key-2',
            rewardXlm: 0.0375,
            tierMultiplier: 1.5,
            txHash: 'tx-2',
            eventIndex: 4,
            tradedAt: new Date('2026-11-06T12:00:00.000Z'),
         }),
      ]);
      rewardGroupBy.mockResolvedValue([
         { holdId: 'hold-1', _sum: { rewardXlm: 0.0625 }, _count: { _all: 2 } },
      ]);
      eventCreateMany.mockResolvedValue({ count: 2 });

      const result = await resolveReferralHold('hold-1', 'RELEASED', 'admin-1');

      expect(eventCreateMany).toHaveBeenCalledTimes(1);
      expect(eventCreateMany).toHaveBeenCalledWith({
         data: [
            {
               walletAddress: 'GREFERRER',
               refereeAddress: 'GREFEREE',
               keyId: 'key-1',
               amount: 0.025,
               tierMultiplier: 1,
               txHash: 'tx-1',
               eventIndex: 0,
               createdAt: new Date('2026-11-05T12:00:00.000Z'),
            },
            {
               walletAddress: 'GREFERRER',
               refereeAddress: 'GREFEREE',
               keyId: 'key-2',
               amount: 0.0375,
               tierMultiplier: 1.5,
               txHash: 'tx-2',
               eventIndex: 4,
               createdAt: new Date('2026-11-06T12:00:00.000Z'),
            },
         ],
      });
      expect(result).toMatchObject({
         id: 'hold-1',
         status: 'RELEASED',
         resolvedBy: 'admin-1',
         rewardXlm: 0.0625,
         withheldTrades: 2,
      });
      expect(current().status).toBe('RELEASED');
   });

   it('reads the withheld rewards only after taking the status lock', async () => {
      useStatefulHold();
      rewardFindMany.mockResolvedValue([rewardRow()]);
      eventCreateMany.mockResolvedValue({ count: 1 });

      await resolveReferralHold('hold-1', 'RELEASED', 'admin-1');

      // A trade withholding a reward concurrently either commits before the
      // lock (and is read here) or sees RELEASED and pays directly.
      expect(holdUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(
         rewardFindMany.mock.invocationCallOrder[0]
      );
   });

   it('triggers the reward distribution once even when released twice', async () => {
      useStatefulHold();
      rewardFindMany.mockResolvedValue([rewardRow()]);
      eventCreateMany.mockResolvedValue({ count: 1 });

      await resolveReferralHold('hold-1', 'RELEASED', 'admin-1');
      await expect(
         resolveReferralHold('hold-1', 'RELEASED', 'admin-2')
      ).rejects.toBeInstanceOf(ReferralHoldAlreadyResolvedError);

      expect(eventCreateMany).toHaveBeenCalledTimes(1);
   });

   it('triggers the reward distribution once under concurrent releases', async () => {
      useStatefulHold();
      rewardFindMany.mockResolvedValue([rewardRow()]);
      eventCreateMany.mockResolvedValue({ count: 1 });

      const results = await Promise.allSettled([
         resolveReferralHold('hold-1', 'RELEASED', 'admin-1'),
         resolveReferralHold('hold-1', 'RELEASED', 'admin-2'),
      ]);

      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      expect(eventCreateMany).toHaveBeenCalledTimes(1);
   });

   it('propagates a payout failure so the surrounding transaction rolls back', async () => {
      // The status change and payout share one $transaction; an error from
      // the payout write must escape it (the real database then rolls the
      // status change back). The stand-in does not model rollback itself.
      useStatefulHold();
      rewardFindMany.mockResolvedValue([rewardRow()]);
      eventCreateMany.mockRejectedValue(new Error('db down'));

      await expect(
         resolveReferralHold('hold-1', 'RELEASED', 'admin-1')
      ).rejects.toThrow('db down');
   });

   it('releases a hold with nothing withheld without writing any fee rows', async () => {
      useStatefulHold();
      const result = await resolveReferralHold('hold-1', 'RELEASED', 'admin-1');
      expect(eventCreateMany).not.toHaveBeenCalled();
      expect(result).toMatchObject({
         status: 'RELEASED',
         rewardXlm: 0,
         withheldTrades: 0,
      });
   });

   it('skips zero-value rewards', async () => {
      useStatefulHold();
      rewardFindMany.mockResolvedValue([
         rewardRow({ rewardXlm: 0 }),
         rewardRow({ id: 'rw-2', rewardXlm: 0.5 }),
      ]);
      eventCreateMany.mockResolvedValue({ count: 1 });

      await resolveReferralHold('hold-1', 'RELEASED', 'admin-1');

      const { data } = eventCreateMany.mock.calls[0][0];
      expect(data).toHaveLength(1);
      expect(data[0].amount).toBe(0.5);
   });

   it('omits txHash and eventIndex when the trade had none', async () => {
      useStatefulHold();
      rewardFindMany.mockResolvedValue([
         rewardRow({ txHash: null, eventIndex: null }),
      ]);
      eventCreateMany.mockResolvedValue({ count: 1 });

      await resolveReferralHold('hold-1', 'RELEASED', 'admin-1');

      const [row] = eventCreateMany.mock.calls[0][0].data;
      expect(row).not.toHaveProperty('txHash');
      expect(row).not.toHaveProperty('eventIndex');
   });
});

describe('resolveReferralHold: reject and guards', () => {
   it('marks the hold REJECTED, reports what was withheld, and never pays', async () => {
      const current = useStatefulHold();
      rewardGroupBy.mockResolvedValue([
         { holdId: 'hold-1', _sum: { rewardXlm: 0.05 }, _count: { _all: 2 } },
      ]);

      const result = await resolveReferralHold('hold-1', 'REJECTED', 'admin-1');

      expect(result).toMatchObject({
         status: 'REJECTED',
         rewardXlm: 0.05,
         withheldTrades: 2,
      });
      expect(current().status).toBe('REJECTED');
      expect(rewardFindMany).not.toHaveBeenCalled();
      expect(eventCreateMany).not.toHaveBeenCalled();
   });

   it('cannot release a hold that detection already rejected', async () => {
      useStatefulHold(holdRow({ status: 'REJECTED', reason: 'SELF_REFERRAL' }));

      await expect(
         resolveReferralHold('hold-1', 'RELEASED', 'admin-1')
      ).rejects.toMatchObject({
         name: 'ReferralHoldAlreadyResolvedError',
         status: 'REJECTED',
      });
      expect(eventCreateMany).not.toHaveBeenCalled();
   });

   it('cannot reject a hold that was already released', async () => {
      useStatefulHold(holdRow({ status: 'RELEASED' }));
      await expect(
         resolveReferralHold('hold-1', 'REJECTED', 'admin-1')
      ).rejects.toBeInstanceOf(ReferralHoldAlreadyResolvedError);
   });

   it('throws not-found for an unknown hold', async () => {
      holdFindUnique.mockResolvedValue(null);
      await expect(
         resolveReferralHold('missing', 'RELEASED', 'admin-1')
      ).rejects.toBeInstanceOf(ReferralHoldNotFoundError);
      expect(holdUpdateMany).not.toHaveBeenCalled();
   });
});

describe('listReferralHolds', () => {
   it('filters by status and returns newest first with totals and a next cursor', async () => {
      const rows = [
         holdRow({ id: 'h3', createdAt: new Date('2026-11-05T12:00:03Z') }),
         holdRow({ id: 'h2', createdAt: new Date('2026-11-05T12:00:02Z') }),
         holdRow({ id: 'h1', createdAt: new Date('2026-11-05T12:00:01Z') }),
      ];
      holdFindMany.mockResolvedValue(rows);
      rewardGroupBy.mockResolvedValue([
         { holdId: 'h3', _sum: { rewardXlm: 0.075 }, _count: { _all: 3 } },
      ]);

      const page = await listReferralHolds({ status: 'PENDING', limit: 2 });

      expect(holdFindMany).toHaveBeenCalledWith(
         expect.objectContaining({
            where: { status: 'PENDING' },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 3,
         })
      );
      // Totals are fetched only for the rows on the page.
      expect(rewardGroupBy).toHaveBeenCalledWith(
         expect.objectContaining({
            where: { holdId: { in: ['h3', 'h2'] } },
         })
      );
      expect(page.items.map(i => i.id)).toEqual(['h3', 'h2']);
      expect(page.has_more).toBe(true);
      expect(page.next_cursor).toEqual(expect.any(String));
      expect(page.items[0]).toMatchObject({
         status: 'PENDING',
         reason: 'FUNDING_CLUSTER',
         rewardXlm: 0.075,
         withheldTrades: 3,
      });
      expect(page.items[1]).toMatchObject({ rewardXlm: 0, withheldTrades: 0 });
   });

   it('continues after a cursor', async () => {
      holdFindMany.mockResolvedValue([]);
      const cursor = encodeCursor({
         createdAt: '2026-11-05T12:00:02.000Z',
         id: 'h2',
      });

      await listReferralHolds({ cursor });

      const { where } = holdFindMany.mock.calls[0][0];
      expect(where.OR).toEqual([
         { createdAt: { lt: new Date('2026-11-05T12:00:02.000Z') } },
         { createdAt: new Date('2026-11-05T12:00:02.000Z'), id: { lt: 'h2' } },
      ]);
   });

   it('rejects a malformed cursor', async () => {
      await expect(
         listReferralHolds({ cursor: 'garbage' })
      ).rejects.toBeInstanceOf(CursorChecksumError);
      expect(holdFindMany).not.toHaveBeenCalled();
   });
});
