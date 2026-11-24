import { NextFunction, Request, Response } from 'express';
import {
   sendSuccess,
   sendValidationError,
} from '../../utils/api-response.utils';
import {
   BalanceHistoryQuerySchema,
   PortfolioAsOfQuerySchema,
} from './balance-history.schemas';
import { balanceHistoryService } from './balance-history.service';
import { WalletHoldingsParamsSchema } from './wallet-holdings.schemas';

export async function httpGetWalletBalanceHistory(
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

      const parsedQuery = BalanceHistoryQuerySchema.safeParse(req.query);
      if (!parsedQuery.success) {
         sendValidationError(
            res,
            'Invalid query parameters',
            parsedQuery.error.issues.map((issue) => ({
               field: issue.path.join('.') || 'query',
               message: issue.message,
            }))
         );
         return;
      }

      const { keyId, from, to } = parsedQuery.data;
      const points = await balanceHistoryService.history(
         parsedParams.data.address,
         keyId,
         from,
         to
      );

      sendSuccess(res, {
         address: parsedParams.data.address,
         keyId,
         from: from ?? null,
         to: to ?? null,
         points,
      });
   } catch (error) {
      next(error);
   }
}

export async function httpGetWalletPortfolioAsOf(
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

      const parsedQuery = PortfolioAsOfQuerySchema.safeParse(req.query);
      if (!parsedQuery.success) {
         sendValidationError(
            res,
            'Invalid query parameters',
            parsedQuery.error.issues.map((issue) => ({
               field: issue.path.join('.') || 'query',
               message: issue.message,
            }))
         );
         return;
      }

      const result = await balanceHistoryService.portfolioAsOf(
         parsedParams.data.address,
         new Date(parsedQuery.data.asOf)
      );

      sendSuccess(res, result);
   } catch (error) {
      next(error);
   }
}
