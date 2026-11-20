// src/modules/portfolio/portfolio-history.controller.ts
// Handler for GET /portfolio/history (#1008). Returns the wallet's total
// holdings value at regular intervals plus the percentage return from the
// first to the last point. Public read of public on-chain data, cached for
// 5 minutes per wallet per range.

import { Request, Response } from 'express';
import {
   ErrorCode,
   sendError,
   sendSuccess,
   sendValidationError,
} from '../../utils/api-response.utils';
import { logger } from '../../utils/logger.utils';
import { PortfolioHistoryQuerySchema } from './portfolio-history.schemas';
import { getPortfolioHistory } from './portfolio-history.service';

export async function httpGetPortfolioHistory(
   req: Request,
   res: Response
): Promise<void> {
   const parsed = PortfolioHistoryQuerySchema.safeParse(req.query);
   if (!parsed.success) {
      sendValidationError(
         res,
         'Invalid query parameters',
         parsed.error.issues.map(
            (issue: { path: (string | number)[]; message: string }) => ({
               field: issue.path.join('.') || 'query',
               message: issue.message,
            })
         )
      );
      return;
   }

   try {
      const result = await getPortfolioHistory(
         parsed.data.wallet,
         parsed.data.range
      );
      sendSuccess(res, result, 200);
   } catch (error) {
      logger.error(
         {
            type: 'portfolio_history_handler_error',
            handler: 'httpGetPortfolioHistory',
            wallet: parsed.data.wallet,
            range: parsed.data.range,
            ...(req.requestId ? { requestId: req.requestId } : {}),
            error,
         },
         'Failed to retrieve portfolio history'
      );
      sendError(
         res,
         500,
         ErrorCode.INTERNAL_ERROR,
         'Failed to retrieve portfolio history'
      );
   }
}
