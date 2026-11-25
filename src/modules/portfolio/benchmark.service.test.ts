import {
   BENCHMARK_CACHE_TTL_SECONDS,
   BenchmarkService,
} from './benchmark.service';
import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      creatorProfile: { findMany: jest.fn() },
      creatorPriceHistory: { findMany: jest.fn() },
      activity: { groupBy: jest.fn() },
   },
}));

jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn(),
   cacheSetJson: jest.fn(),
}));

describe('BenchmarkService', () => {
   const service = new BenchmarkService();

   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('returns cached benchmark series when present', async () => {
      const cached = {
         range: '7d',
         equalWeightMarket: [{ date: '2026-11-24', value: 100, priceCarriedForward: false }],
         top10Volume: [{ date: '2026-11-24', value: 100, priceCarriedForward: false }],
         xlm: [{ date: '2026-11-24', value: 100, priceCarriedForward: false }],
         returnsPct: { equalWeightMarket: 0, top10Volume: 0, xlm: 0 },
      };
      (cacheGetJson as jest.Mock).mockResolvedValue(cached);

      const res = await service.series('7d');
      expect(res).toEqual(cached);
      expect((prisma as any).creatorProfile.findMany).not.toHaveBeenCalled();
   });

   it('normalizes all series to 100 at start and caches for 15 minutes', async () => {
      (cacheGetJson as jest.Mock).mockResolvedValue(null);
      ((prisma as any).creatorProfile.findMany as jest.Mock).mockResolvedValue([
         { id: 'k1', circulatingSupply: 100 },
      ]);
      ((prisma as any).activity.groupBy as jest.Mock).mockResolvedValue([
         { creatorId: 'k1', _count: { _all: 5 } },
      ]);

      const now = new Date('2026-11-10T12:00:00Z');
      ((prisma as any).creatorPriceHistory.findMany as jest.Mock).mockResolvedValue([
         {
            creatorId: 'k1',
            price: BigInt(10_000_000),
            recordedAt: new Date('2026-11-03T10:00:00Z'),
         },
         {
            creatorId: 'k1',
            price: BigInt(15_000_000),
            recordedAt: new Date('2026-11-10T10:00:00Z'),
         },
      ]);

      const res = await service.series('7d', now);

      expect(res.equalWeightMarket[0].value).toBe(100);
      expect(res.top10Volume[0].value).toBe(100);
      expect(res.xlm[0].value).toBe(100);
      expect(res.equalWeightMarket[res.equalWeightMarket.length - 1].value).toBe(150);
      expect(res.returnsPct.equalWeightMarket).toBe(50);
      expect(cacheSetJson).toHaveBeenCalledWith(
         'benchmark:series:v1:7d',
         res,
         BENCHMARK_CACHE_TTL_SECONDS
      );
   });
});
