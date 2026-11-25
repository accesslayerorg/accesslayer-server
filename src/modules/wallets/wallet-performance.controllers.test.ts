import { Request, Response, NextFunction } from 'express';
import { httpGetWalletPerformance } from './wallet-performance.controllers';
import { returnsService } from '../portfolio/returns.service';
import { benchmarkService } from '../portfolio/benchmark.service';

jest.mock('../portfolio/returns.service', () => {
   const actual = jest.requireActual('../portfolio/returns.service');
   return {
      ...actual,
      returnsService: {
         timeWeighted: jest.fn(),
      },
   };
});

jest.mock('../portfolio/benchmark.service', () => ({
   benchmarkService: {
      series: jest.fn(),
   },
}));

describe('httpGetWalletPerformance', () => {
   const validAddress =
      'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';

   it('returns portfolio, benchmarks, and summary differences equal to portfolio minus benchmark', async () => {
      (returnsService.timeWeighted as jest.Mock).mockResolvedValue({
         wallet: validAddress,
         range: '30d',
         series: [
            {
               date: '2026-11-01',
               value: 100,
               portfolioValueXlm: 100,
               priceCarriedForward: false,
            },
            {
               date: '2026-11-02',
               value: 120,
               portfolioValueXlm: 120,
               priceCarriedForward: false,
            },
         ],
         totalReturnPct: 20,
         hasPriceCarryForward: false,
      });

      (benchmarkService.series as jest.Mock).mockResolvedValue({
         range: '30d',
         equalWeightMarket: [
            { date: '2026-11-01', value: 100, priceCarriedForward: false },
            { date: '2026-11-02', value: 112.5, priceCarriedForward: false },
         ],
         top10Volume: [
            { date: '2026-11-01', value: 100, priceCarriedForward: false },
            { date: '2026-11-02', value: 125, priceCarriedForward: false },
         ],
         xlm: [
            { date: '2026-11-01', value: 100, priceCarriedForward: false },
            { date: '2026-11-02', value: 100, priceCarriedForward: false },
         ],
         returnsPct: {
            equalWeightMarket: 12.5,
            top10Volume: 25,
            xlm: 0,
         },
      });

      const req = {
         params: { address: validAddress },
         query: { range: '30d' },
      } as unknown as Request;
      const json = jest.fn();
      const status = jest.fn().mockReturnValue({ json });
      const res = { status, json } as unknown as Response;
      const next = jest.fn() as NextFunction;

      await httpGetWalletPerformance(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(status).toHaveBeenCalledWith(200);
      const body = json.mock.calls[0][0];
      expect(body.data.summary.differences).toEqual({
         equalWeightMarket: 7.5,
         top10Volume: -5,
         xlm: 20,
      });
   });
});
