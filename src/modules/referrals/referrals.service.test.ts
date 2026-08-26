// src/modules/referrals/referrals.service.test.ts
// Unit tests for referral summary, breakdown pagination and recording.

import {
   getReferralSummary,
   getReferralBreakdown,
   recordReferralFee,
} from './referrals.service';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      referralFee: {
         aggregate: jest.fn(),
         findMany: jest.fn(),
         create: jest.fn(),
      },
   },
}));

jest.mock('./referrals.cache', () => ({
   invalidateReferralSummary: jest.fn(),
}));

import { prisma } from '../../utils/prisma.utils';
import { invalidateReferralSummary } from './referrals.cache';

const aggregate = prisma.referralFee.aggregate as jest.Mock;
const findMany = prisma.referralFee.findMany as jest.Mock;
const create = prisma.referralFee.create as jest.Mock;

describe('getReferralSummary', () => {
   afterEach(() => jest.clearAllMocks());

   it('sums totalEarned and counts referralCount', async () => {
      aggregate.mockResolvedValue({ _sum: { amount: '13.5' }, _count: 3 });

      const result = await getReferralSummary('W1');

      expect(result).toEqual({ totalEarned: 13.5, referralCount: 3 });
   });
});

describe('getReferralBreakdown', () => {
   afterEach(() => jest.clearAllMocks());

   it('paginates with a cursor and reports hasNextPage', async () => {
      const mk = (id: string, iso: string) => ({
         keyId: `k${id}`,
         creatorName: `Creator ${id}`,
         amount: '1',
         createdAt: new Date(iso),
         id,
      });
      findMany.mockResolvedValue([
         mk('a', '2024-01-03T00:00:00Z'),
         mk('b', '2024-01-02T00:00:00Z'),
         mk('c', '2024-01-01T00:00:00Z'), // extra => hasNextPage
      ]);

      const page = await getReferralBreakdown('W1', { limit: 2 });

      expect(page.items).toHaveLength(2);
      expect(page.hasNextPage).toBe(true);
      expect(page.nextCursor).not.toBeNull();
   });

   it('clamps limit to the max of 100', async () => {
      findMany.mockResolvedValue([]);
      await getReferralBreakdown('W1', { limit: 500 });
      expect(findMany).toHaveBeenCalledWith(
         expect.objectContaining({ take: 101 })
      );
   });
});

describe('recordReferralFee', () => {
   afterEach(() => jest.clearAllMocks());

   it('persists the fee and invalidates the wallet summary cache', async () => {
      create.mockResolvedValue({});
      await recordReferralFee({
         wallet: 'W1',
         keyId: 'k1',
         creatorId: 'c1',
         creatorName: 'Creator',
         amount: 2,
         txHash: '0xabc',
      });

      expect(create).toHaveBeenCalledTimes(1);
      expect(invalidateReferralSummary).toHaveBeenCalledWith('W1');
   });
});
