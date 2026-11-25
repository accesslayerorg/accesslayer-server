import { NextFunction, Request, Response } from 'express';
import {
   sendSuccess,
   sendValidationError,
} from '../../utils/api-response.utils';
import { WalletHoldingsParamsSchema } from './wallet-holdings.schemas';
import { WalletPerformanceQuerySchema } from './wallet-performance.schemas';
import { returnsService } from '../portfolio/returns.service';
import { benchmarkService } from '../portfolio/benchmark.service';

function round4(n: number): number {
   return Number(n.toFixed(4));
}

export async function httpGetWalletPerformance(
   req: Request,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const parsedParams = WalletHoldingsParamsSchema.safeParse(req.params);
      if (!parsedParams.success) {
         sendValidationError(
            res,
            'Invalid wallet address',
            parsedParams.error.issues.map((issue) => ({
               field: 'address',
               message: issue.message,
            }))
         );
         return;
      }

      const parsedQuery = WalletPerformanceQuerySchema.safeParse(req.query);
      if (!parsedQuery.success) {
         sendValidationError(
            res,
            'Invalid query parameters',
            parsedQuery.error.issues.map((issue) => ({
               field: issue.path.join('.') || 'range',
               message: issue.message,
            }))
         );
         return;
      }

      const { address } = parsedParams.data;
      const { range } = parsedQuery.data;

      const [portfolioResult, benchmarks] = await Promise.all([
         returnsService.timeWeighted(address, range),
         benchmarkService.series(range),
      ]);

      const pRet = portfolioResult.totalReturnPct;

      sendSuccess(res, {
         address,
         range,
         portfolio: portfolioResult.series,
         benchmarks: {
            equalWeightMarket: benchmarks.equalWeightMarket,
            top10Volume: benchmarks.top10Volume,
            xlm: benchmarks.xlm,
         },
         summary: {
            portfolioReturnPct: pRet,
            hasPriceCarryForward: portfolioResult.hasPriceCarryForward,
            differences: {
               equalWeightMarket: round4(
                  pRet - benchmarks.returnsPct.equalWeightMarket
               ),
               top10Volume: round4(pRet - benchmarks.returnsPct.top10Volume),
               xlm: round4(pRet - benchmarks.returnsPct.xlm),
            },
         },
      });
   } catch (error) {
      next(error);
   }
}
