import { getTreasurySummary } from './treasury.service';
import { prisma } from '../../utils/prisma.utils';

jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn().mockResolvedValue(null),
   cacheSetJson: jest.fn().mockResolvedValue(undefined),
   cacheInvalidate: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      treasuryBalance: { findMany: jest.fn() },
      treasuryAllocation: { aggregate: jest.fn() },
   },
}));

/** Minimal stand-in for a Prisma Decimal: only toFixed is used by the service. */
const decimal = (value: string) => ({ toFixed: () => value });

describe('getTreasurySummary', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('nets allocations against gross inflows for total_balance', async () => {
      const updatedAt = new Date('2026-10-20T10:00:00.000Z');
      (prisma.treasuryBalance.findMany as jest.Mock).mockResolvedValue([
         { source: 'fees', balance: decimal('1000'), updatedAt },
         {
            source: 'trading',
            balance: decimal('500'),
            updatedAt: new Date('2026-10-21T10:00:00.000Z'),
         },
      ]);
      (prisma.treasuryAllocation.aggregate as jest.Mock).mockResolvedValue({
         _sum: { amount: decimal('300') },
      });

      const summary = await getTreasurySummary();

      expect(summary.total_balance).toBe('1200');
      expect(summary.per_source_breakdown).toEqual([
         { source: 'fees', balance: '1000' },
         { source: 'trading', balance: '500' },
      ]);
      expect(summary.last_updated).toBe('2026-10-21T10:00:00.000Z');
   });

   it('reports zero and null last_updated when nothing has been indexed', async () => {
      (prisma.treasuryBalance.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.treasuryAllocation.aggregate as jest.Mock).mockResolvedValue({
         _sum: { amount: null },
      });

      const summary = await getTreasurySummary();

      expect(summary).toEqual({
         total_balance: '0',
         per_source_breakdown: [],
         last_updated: null,
      });
   });
});
