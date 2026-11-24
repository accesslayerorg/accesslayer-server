import {
   buildDailyPriceSeries,
   computeChainedTimeWeightedReturns,
   ReturnsService,
} from './returns.service';
import { prisma } from '../../utils/prisma.utils';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      balanceCheckpoint: {
         findMany: jest.fn(),
      },
      creatorPriceHistory: {
         findMany: jest.fn(),
      },
   },
}));

describe('ReturnsService & TWR math', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('computes chained sub-period returns unaffected by deposits and withdrawals', () => {
      const days = ['2026-11-01', '2026-11-02', '2026-11-03'];

      // Price doubles from 10 to 20 on day 2, then drops 50% from 20 to 10 on day 3.
      // True TWR: (1 + 1.0) * (1 - 0.5) - 1 = 0% (index: 100 -> 200 -> 100)
      // Even though wallet deposits +90 keys on day 2!
      const dailyPricesByKey = new Map([
         [
            'key-1',
            buildDailyPriceSeries(days, [
               { priceXlm: 10, recordedAt: new Date('2026-11-01T12:00:00Z') },
               { priceXlm: 20, recordedAt: new Date('2026-11-02T12:00:00Z') },
               { priceXlm: 10, recordedAt: new Date('2026-11-03T12:00:00Z') },
            ]),
         ],
      ]);

      const withDeposit = computeChainedTimeWeightedReturns({
         days,
         checkpoints: [
            {
               holder: 'GWALLET',
               keyId: 'key-1',
               ledger: 10,
               balance: 10,
               timestamp: new Date('2026-11-01T08:00:00Z'),
            },
            {
               holder: 'GWALLET',
               keyId: 'key-1',
               ledger: 20,
               balance: 100, // huge deposit on day 2
               timestamp: new Date('2026-11-02T15:00:00Z'),
            },
         ],
         dailyPricesByKey,
      });

      const withoutDeposit = computeChainedTimeWeightedReturns({
         days,
         checkpoints: [
            {
               holder: 'GWALLET',
               keyId: 'key-1',
               ledger: 10,
               balance: 10,
               timestamp: new Date('2026-11-01T08:00:00Z'),
            },
         ],
         dailyPricesByKey,
      });

      expect(withDeposit.series.map((p) => p.value)).toEqual([100, 200, 100]);
      expect(withoutDeposit.series.map((p) => p.value)).toEqual([
         100, 200, 100,
      ]);
      expect(withDeposit.totalReturnPct).toBe(0);
      expect(withoutDeposit.totalReturnPct).toBe(0);
   });

   it('carries missing price days forward and sets priceCarriedForward flag', () => {
      const days = ['2026-11-01', '2026-11-02', '2026-11-03'];
      const dailyPricesByKey = new Map([
         [
            'key-1',
            buildDailyPriceSeries(days, [
               { priceXlm: 10, recordedAt: new Date('2026-11-01T12:00:00Z') },
               // Nov 2 missing
               { priceXlm: 15, recordedAt: new Date('2026-11-03T12:00:00Z') },
            ]),
         ],
      ]);

      const res = computeChainedTimeWeightedReturns({
         days,
         checkpoints: [
            {
               holder: 'GWALLET',
               keyId: 'key-1',
               ledger: 10,
               balance: 5,
               timestamp: new Date('2026-11-01T08:00:00Z'),
            },
         ],
         dailyPricesByKey,
      });

      expect(res.hasPriceCarryForward).toBe(true);
      expect(res.series[1].priceCarriedForward).toBe(true);
      expect(res.series[1].portfolioValueXlm).toBe(50);
      expect(res.series[2].priceCarriedForward).toBe(false);
      expect(res.series[2].value).toBe(150);
   });

   it('returns empty series without errors for empty portfolios', async () => {
      ((prisma as any).balanceCheckpoint.findMany as jest.Mock).mockResolvedValue(
         []
      );

      const service = new ReturnsService();
      const res = await service.timeWeighted('GEMPTY', '30d');

      expect(res.series).toEqual([]);
      expect(res.totalReturnPct).toBe(0);
      expect(res.hasPriceCarryForward).toBe(false);
   });
});
