// src/modules/analytics/analytics.service.test.ts
// Unit tests for the 30-day key analytics aggregation.

import { getKeyAnalytics } from './analytics.service';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      trade: {
         findMany: jest.fn(),
         groupBy: jest.fn(),
      },
   },
}));

import { prisma } from '../../utils/prisma.utils';

const findMany = prisma.trade.findMany as jest.Mock;
const groupBy = prisma.trade.groupBy as jest.Mock;

function dayOffset(daysAgo: number, hour = 12): Date {
   const d = new Date();
   d.setUTCDate(d.getUTCDate() - daysAgo);
   d.setUTCHours(hour, 0, 0, 0);
   return d;
}

describe('getKeyAnalytics', () => {
   afterEach(() => jest.clearAllMocks());

   it('returns exactly 30 daily buckets', async () => {
      findMany.mockResolvedValue([]);
      groupBy.mockResolvedValue([]);

      const result = await getKeyAnalytics('key1');

      expect(result.points).toHaveLength(30);
      // Dates must be unique and ordered oldest -> newest.
      const dates = result.points.map((p) => p.date);
      expect(new Set(dates).size).toBe(30);
      // ISO date strings sort lexicographically.
      expect(dates[0] < dates[29]).toBe(true);
   });

   it('sums tradeVolume and counts unique active holders per day', async () => {
      // Two trades same day, same wallet (only 1 active holder) + one other wallet.
      findMany.mockResolvedValue([
         {
            wallet: 'W1',
            side: 'BUY',
            amount: '10',
            createdAt: dayOffset(2, 10),
         },
         {
            wallet: 'W1',
            side: 'SELL',
            amount: '5',
            createdAt: dayOffset(2, 14),
         },
         {
            wallet: 'W2',
            side: 'BUY',
            amount: '3',
            createdAt: dayOffset(2, 16),
         },
      ]);
      groupBy.mockResolvedValue([]);

      const result = await getKeyAnalytics('key1');
      const bucket = result.points[result.points.length - 1 - 2];

      expect(bucket.activeHolders).toBe(2);
      expect(bucket.tradeVolume).toBe(18); // 10 + 5 + 3
   });

   it('counts newHolders as wallets whose first-ever BUY is that day', async () => {
      findMany.mockResolvedValue([]);
      groupBy.mockResolvedValue([
         { wallet: 'W1', _min: { createdAt: dayOffset(5, 9) } },
         { wallet: 'W2', _min: { createdAt: dayOffset(2, 9) } },
         // First buy 100 days ago -> not in window, ignored.
         { wallet: 'W3', _min: { createdAt: dayOffset(100, 9) } },
      ]);

      const result = await getKeyAnalytics('key1');
      const day5 = result.points[result.points.length - 1 - 5];
      const day2 = result.points[result.points.length - 1 - 2];

      expect(day5.newHolders).toBe(1);
      expect(day2.newHolders).toBe(1);
   });
});
