// Unit tests: creator analytics aggregation (Feature: key analytics)
//
// Verifies against the acceptance criteria:
//   - endpoint math produces exactly 30 daily data points
//   - activeHolders counts unique trading wallets per day
//   - newHolders counts only first-ever buyers per day
//   - tradeVolume sums buy AND sell XLM amounts per day

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      activity: {
         findMany: jest.fn(),
         groupBy: jest.fn(),
      },
   },
}));

import { prisma } from '../../utils/prisma.utils';
import {
   extractXlmAmount,
   getCreatorAnalytics,
} from './creator-analytics.service';

const activityFindMany = prisma.activity.findMany as jest.Mock;
const activityGroupBy = prisma.activity.groupBy as jest.Mock;

const NOW = new Date('2026-08-26T12:00:00.000Z');
const TODAY = '2026-08-26';
const MID_WINDOW = '2026-08-10';
const FIRST_BUY_DAY = '2026-08-15';

function trade(
   actor: string,
   type: 'KEY_BOUGHT' | 'KEY_SOLD',
   day: string,
   amount: number
) {
   return {
      actor,
      type,
      payload: { amount },
      createdAt: new Date(`${day}T10:00:00.000Z`),
   };
}

describe('creator-analytics.service', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   describe('getCreatorAnalytics', () => {
      function setupTrades() {
         const trades = [
            // Today: wallet A trades twice (buy + sell), B buys once,
            // E (holder since before window) sells — still counts as active.
            trade('A', 'KEY_BOUGHT', TODAY, 10),
            trade('A', 'KEY_SOLD', TODAY, 4),
            trade('B', 'KEY_BOUGHT', TODAY, 5),
            trade('E', 'KEY_SOLD', TODAY, 2),
            // Mid-window: C only ever sold — active + volume, never a newHolder.
            trade('C', 'KEY_SOLD', MID_WINDOW, 7),
            // First buy mid-window for D.
            trade('D', 'KEY_BOUGHT', FIRST_BUY_DAY, 3),
         ];
         activityFindMany.mockResolvedValue(trades);

         const firstBuys = [
            { actor: 'A', _min: { createdAt: new Date(`${TODAY}T09:00:00.000Z`) } },
            { actor: 'B', _min: { createdAt: new Date(`${TODAY}T11:00:00.000Z`) } },
            { actor: 'D', _min: { createdAt: new Date(`${FIRST_BUY_DAY}T09:00:00.000Z`) } },
            // E bought before the 30-day window: must NOT be a newHolder.
            { actor: 'E', _min: { createdAt: new Date('2026-07-01T09:00:00.000Z') } },
         ];
         activityGroupBy.mockResolvedValue(firstBuys);
      }

      function findByDate(
         series: { date: string }[],
         date: string
      ): Record<string, number> {
         const point = series.find((entry) => entry.date === date);
         expect(point).toBeDefined();
         return point as unknown as Record<string, number>;
      }

      it('returns exactly 30 data points ordered oldest to newest', async () => {
         setupTrades();
         const result = await getCreatorAnalytics('key-1', NOW);

         expect(result.series).toHaveLength(30);
         expect(result.series[0].date).toBe('2026-07-28');
         expect(result.series[29].date).toBe(TODAY);
         expect(result.windowDays).toBe(30);
      });

      it('counts unique trading wallets per day for activeHolders', async () => {
         setupTrades();
         const result = await getCreatorAnalytics('key-1', NOW);

         const today = findByDate(result.series, TODAY);
         // A, B, E traded today (A twice but is one wallet).
         expect(today.activeHolders).toBe(3);
      });

      it('counts only first-ever buyers for newHolders', async () => {
         setupTrades();
         const result = await getCreatorAnalytics('key-1', NOW);

         const today = findByDate(result.series, TODAY);
         // A and B bought for the first time today; E's first buy predates
         // the window so it is excluded even though E traded today.
         expect(today.newHolders).toBe(2);

         const firstBuyDayPoint = findByDate(result.series, FIRST_BUY_DAY);
         expect(firstBuyDayPoint.newHolders).toBe(1);
      });

      it('sums buy AND sell amounts into daily tradeVolume', async () => {
         setupTrades();
         const result = await getCreatorAnalytics('key-1', NOW);

         const today = findByDate(result.series, TODAY);
         expect(today.tradeVolume).toBeCloseTo(21, 7); // 10 + 4 + 5 + 2

         const mid = findByDate(result.series, MID_WINDOW);
         expect(mid.tradeVolume).toBeCloseTo(7, 7); // sells count too
      });

      it('zero-fills days without trades', async () => {
         setupTrades();
         const result = await getCreatorAnalytics('key-1', NOW);

         const quiet = findByDate(result.series, '2026-08-02');
         expect(quiet.activeHolders).toBe(0);
         expect(quiet.tradeVolume).toBe(0);
         expect(quiet.newHolders).toBe(0);
      });

      it('scopes both queries to the requested key', async () => {
         setupTrades();
         await getCreatorAnalytics('key-42', NOW);

         expect(activityFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
               where: expect.objectContaining({ creatorId: 'key-42' }),
            })
         );
         expect(activityGroupBy).toHaveBeenCalledWith(
            expect.objectContaining({
               by: ['actor'],
               where: expect.objectContaining({ creatorId: 'key-42' }),
            })
         );
      });
   });

   describe('extractXlmAmount', () => {
      it.each([
         [{ amount: '12.5' }, 12.5],
         [{ price: 8 }, 8],
         [{ value: '3' }, 3],
         [null, 0],
         ['nope', 0],
         [{}, 0],
         [{ amount: 'not-a-number' }, 0],
      ])('extracts %j as %d', (payload, expected) => {
         expect(extractXlmAmount(payload)).toBe(expected);
      });
   });
});
