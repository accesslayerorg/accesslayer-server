// src/modules/swaps/swaps.controllers.ts
// Express request handlers for atomic swap proposal endpoints (#1087)

import { Request, Response, NextFunction } from 'express';
import {
   SwapWalletParamSchema,
   SwapIdParamSchema,
   SwapsQuerySchema,
} from './swaps.schemas';
import {
   fetchOutgoingSwaps,
   fetchIncomingSwaps,
   fetchSwapById,
} from './swaps.service';
import {
   sendSuccess,
   sendNotFound,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import { logger } from '../../utils/logger.utils';

/**
 * GET /swaps/:wallet/outgoing
 *
 * Paginated outgoing proposals for a proposer wallet with status and expiry countdown (#1087).
 */
export async function httpGetOutgoingSwaps(
   req: Request,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const parsedParams = SwapWalletParamSchema.safeParse(req.params);
      if (!parsedParams.success) {
         sendValidationError(
            res,
            'Invalid wallet parameter',
            zodIssuesToDetails(parsedParams.error.issues)
         );
         return;
      }

      const parsedQuery = SwapsQuerySchema.safeParse(req.query);
      if (!parsedQuery.success) {
         sendValidationError(
            res,
            'Invalid query parameters',
            zodIssuesToDetails(parsedQuery.error.issues)
         );
         return;
      }

      const wallet = parsedParams.data.wallet;
      const result = await fetchOutgoingSwaps(wallet, parsedQuery.data);

      sendSuccess(res, result);
   } catch (error) {
      logger.error(
         { error, wallet: req.params.wallet },
         'Failed to get outgoing swaps'
      );
      next(error);
   }
}

/**
 * GET /swaps/:wallet/incoming
 *
 * Paginated incoming proposals for a counterparty wallet awaiting acceptance (#1087).
 */
export async function httpGetIncomingSwaps(
   req: Request,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const parsedParams = SwapWalletParamSchema.safeParse(req.params);
      if (!parsedParams.success) {
         sendValidationError(
            res,
            'Invalid wallet parameter',
            zodIssuesToDetails(parsedParams.error.issues)
         );
         return;
      }

      const parsedQuery = SwapsQuerySchema.safeParse(req.query);
      if (!parsedQuery.success) {
         sendValidationError(
            res,
            'Invalid query parameters',
            zodIssuesToDetails(parsedQuery.error.issues)
         );
         return;
      }

      const wallet = parsedParams.data.wallet;
      const result = await fetchIncomingSwaps(wallet, parsedQuery.data);

      sendSuccess(res, result);
   } catch (error) {
      logger.error(
         { error, wallet: req.params.wallet },
         'Failed to get incoming swaps'
      );
      next(error);
   }
}

/**
 * GET /swaps/:swap_id
 *
 * Single swap proposal detail with accurate offered/requested key and amount data (#1087).
 */
export async function httpGetSwapById(
   req: Request,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const rawSwapId = req.params.swap_id || req.params.swapId;
      const parsedParams = SwapIdParamSchema.safeParse({ swap_id: rawSwapId });
      if (!parsedParams.success) {
         sendValidationError(
            res,
            'Invalid swap ID parameter',
            zodIssuesToDetails(parsedParams.error.issues)
         );
         return;
      }

      const swapId = parsedParams.data.swap_id;
      const swap = await fetchSwapById(swapId);

      if (!swap) {
         sendNotFound(res, 'Swap proposal');
         return;
      }

      sendSuccess(res, swap);
   } catch (error) {
      logger.error(
         { error, swap_id: req.params.swap_id || req.params.swapId },
         'Failed to get swap proposal'
      );
      next(error);
   }
}
