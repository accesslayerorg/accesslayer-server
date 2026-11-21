// src/modules/portfolio/portfolio-pnl.controller.ts
// Handler for GET /api/v1/portfolio/pnl (#897). Authenticated wallet only,
// live bonding-curve price on every request (explicit no-store, no Redis).

import { Response } from 'express';
import { ErrorCode, sendError, sendSuccess } from '../../utils/api-response.utils';
import { logger } from '../../utils/logger.utils';
import { AuthenticatedRequest } from '../../middlewares/jwt-auth.middleware';
import { getPortfolioPnl } from './portfolio-pnl.service';

export async function httpGetPortfolioPnl(
   req: AuthenticatedRequest,
   res: Response
): Promise<void> {
   try {
      const wallet = req.user?.wallet;
      if (!wallet) {
         sendError(res, 401, ErrorCode.UNAUTHORIZED, 'Authentication required');
         return;
      }

      const result = await getPortfolioPnl(wallet);

      res.setHeader('Cache-Control', 'no-store');
      sendSuccess(res, result, 200);
   } catch (error) {
      logger.error(
         {
            type: 'portfolio_pnl_handler_error',
            handler: 'httpGetPortfolioPnl',
            ...(req.requestId ? { requestId: req.requestId } : {}),
            error,
         },
         'Failed to retrieve portfolio P&L'
      );
      sendError(res, 500, ErrorCode.INTERNAL_ERROR, 'Failed to retrieve portfolio P&L');
   }
}
