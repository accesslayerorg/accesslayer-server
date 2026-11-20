// Unit tests for referral hold review (#1241): release pays exactly once,
// rejected and already-resolved holds never pay, and held rewards stay unpaid.

jest.mock('../../utils/prisma.utils', () => {
   const referralHold = {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
      findMany: jest.fn(),
   };
   const referralEvent = { create: jest.fn() };
   return {
      prisma: {
         referralHold,
         referralEvent,
         $transaction: jest.fn((cb: (tx: unknown) => unknown) =>
            cb({ referralHold, referralEvent })
         ),
      },
   };
});

import { prisma } from '../../utils/prisma.utils';
import { encodeCursor } from '../../utils/cursor.utils';
import { CursorChecksumError } from '../../utils/cursor.utils';
import {
   listReferralHolds,
   ReferralHoldAlreadyResolvedError,
   ReferralHoldNotFoundError,
   resolveReferralHold,
} from './referral-hold.service';

const holdFindUnique = prisma.referralHold.findUnique as jest.Mock;
const holdUpdateMany = prisma.referralHold.updateMany as jest.Mock;
const holdFindMany = prisma.referralHold.findMany as jest.Mock;
const eventCreate = prisma.referralEvent.create as jest.Mock;

const TRADED_AT = new Date('2026-11-05T12:00:00.000Z');

function holdRow(overrides: Record<string, unknown> = {}) {
   return {
      id: 'hold-1',
      referralId: 'ref-1',
      reason: 'FUNDING_CLUSTER',
      status: 'PENDING',
      details: { funder: 'GFUNDER' },
      referrerAddress: 'GREFERRER',
      refereeAddress: 'GREFEREE',
      keyId: 'key-1',
      rewardXlm: 0.5,
      txHash: 'tx-1',
      eventIndex: 3,
      tradedAt: TRADED_AT,
      resolvedBy: null,
      resolvedAt: null,
      createdAt: new Date('2026-11-05T12:00:01.000Z'),
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
            referralEvent: prisma.referralEvent,
         })
   );
});

describe('resolveReferralHold: release', () => {
   it('pays the withheld reward to the referrer and marks the hold RELEASED', async () => {
      const current = useStatefulHold();
      eventCreate.mockResolvedValue({});

      const result = await resolveReferralHold('hold-1', 'RELEASED', 'admin-1');

      expect(eventCreate).toHaveBeenCalledTimes(1);
      expect(eventCreate).toHaveBeenCalledWith({
         data: {
            walletAddress: 'GREFERRER',
            refereeAddress: 'GREFEREE',
            keyId: 'key-1',
            amount: 0.5,
            txHash: 'tx-1',
            eventIndex: 3,
            createdAt: TRADED_AT,
         },
      });
      expect(result).toMatchObject({
         id: 'hold-1',
         status: 'RELEASED',
         resolvedBy: 'admin-1',
         rewardXlm: 0.5,
      });
      expect(current().status).toBe('RELEASED');
   });

   it('triggers the reward distribution once even when released twice', async () => {
      useStatefulHold();
      eventCreate.mockResolvedValue({});

      await resolveReferralHold('hold-1', 'RELEASED', 'admin-1');
      await expect(
         resolveReferralHold('hold-1', 'RELEASED', 'admin-2')
      ).rejects.toBeInstanceOf(ReferralHoldAlreadyResolvedError);

      expect(eventCreate).toHaveBeenCalledTimes(1);
   });

   it('triggers the reward distribution once under concurrent releases', async () => {
      useStatefulHold();
      eventCreate.mockResolvedValue({});

      const results = await Promise.allSettled([
         resolveReferralHold('hold-1', 'RELEASED', 'admin-1'),
         resolveReferralHold('hold-1', 'RELEASED', 'admin-2'),
      ]);

      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      expect(eventCreate).toHaveBeenCalledTimes(1);
   });

   it('propagates a payout failure so the surrounding transaction rolls back', async () => {
      // The status change and payout share one $transaction; an error from
      // the payout write must escape it (the real database then rolls the
      // status change back). The stand-in does not model rollback itself.
      useStatefulHold();
      eventCreate.mockRejectedValue(new Error('db down'));

      await expect(
         resolveReferralHold('hold-1', 'RELEASED', 'admin-1')
      ).rejects.toThrow('db down');
   });

   it('does not write a zero-value fee row', async () => {
      useStatefulHold(holdRow({ rewardXlm: 0 }));
      await resolveReferralHold('hold-1', 'RELEASED', 'admin-1');
      expect(eventCreate).not.toHaveBeenCalled();
   });

   it('omits txHash and eventIndex when the trade had none', async () => {
      useStatefulHold(holdRow({ txHash: null, eventIndex: null }));
      await resolveReferralHold('hold-1', 'RELEASED', 'admin-1');
      const { data } = eventCreate.mock.calls[0][0];
      expect(data).not.toHaveProperty('txHash');
      expect(data).not.toHaveProperty('eventIndex');
   });
});

describe('resolveReferralHold: reject and guards', () => {
   it('marks the hold REJECTED and never pays', async () => {
      const current = useStatefulHold();

      const result = await resolveReferralHold('hold-1', 'REJECTED', 'admin-1');

      expect(result.status).toBe('REJECTED');
      expect(current().status).toBe('REJECTED');
      expect(eventCreate).not.toHaveBeenCalled();
   });

   it('cannot release a hold that detection already rejected', async () => {
      useStatefulHold(holdRow({ status: 'REJECTED', reason: 'SELF_REFERRAL' }));

      await expect(
         resolveReferralHold('hold-1', 'RELEASED', 'admin-1')
      ).rejects.toMatchObject({
         name: 'ReferralHoldAlreadyResolvedError',
         status: 'REJECTED',
      });
      expect(eventCreate).not.toHaveBeenCalled();
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
   it('filters by status and returns newest first with a next cursor', async () => {
      const rows = [
         holdRow({ id: 'h3', createdAt: new Date('2026-11-05T12:00:03Z') }),
         holdRow({ id: 'h2', createdAt: new Date('2026-11-05T12:00:02Z') }),
         holdRow({ id: 'h1', createdAt: new Date('2026-11-05T12:00:01Z') }),
      ];
      holdFindMany.mockResolvedValue(rows);

      const page = await listReferralHolds({ status: 'PENDING', limit: 2 });

      expect(holdFindMany).toHaveBeenCalledWith(
         expect.objectContaining({
            where: { status: 'PENDING' },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 3,
         })
      );
      expect(page.items.map(i => i.id)).toEqual(['h3', 'h2']);
      expect(page.has_more).toBe(true);
      expect(page.next_cursor).toEqual(expect.any(String));
      expect(page.items[0]).toMatchObject({
         status: 'PENDING',
         reason: 'FUNDING_CLUSTER',
         rewardXlm: 0.5,
         tradedAt: '2026-11-05T12:00:00.000Z',
      });
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
