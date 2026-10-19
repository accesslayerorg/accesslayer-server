// src/modules/referrals/referral-earnings.controller.ts
// Handlers for the referral earnings endpoints (#1057). Both routes are
// wallet-scoped: the JWT wallet must match the `:wallet` path param (see
// `requireWalletParamMatch`).

import { Response } from 'express';
import {
   ErrorCode,
   sendError,
   sendSuccess,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import { logger } from '../../utils/logger.utils';
import { CursorChecksumError } from '../../utils/cursor.utils';
import { AuthenticatedRequest } from '../../middlewares/jwt-auth.middleware';
import { ReferralEarningsQuerySchema } from './referral-earnings.schemas';
import {
   getReferralEarnings,
   getReferralEarningsSummary,
} from './referral-earnings.service';

function readWalletParam(req: AuthenticatedRequest): string {
   const raw = req.params.wallet;
   return (Array.isArray(raw) ? raw[0] : raw).trim();
}

/**
 * GET /api/v1/referrals/:wallet/earnings
 * Paginated referral earnings history with optional `from`/`to` date range.
 */
export async function httpGetReferralEarnings(
   req: AuthenticatedRequest,
   res: Response
): Promise<void> {
   const wallet = readWalletParam(req);

   const parsed = ReferralEarningsQuerySchema.safeParse(req.query);
   if (!parsed.success) {
      sendValidationError(
         res,
         'Invalid query parameters',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }

   try {
      const result = await getReferralEarnings({ wallet, ...parsed.data });
      sendSuccess(res, result, 200, 'Referral earnings retrieved successfully');
   } catch (error) {
      if (error instanceof CursorChecksumError) {
         sendValidationError(res, 'Invalid cursor', [
            { field: 'cursor', message: error.message },
         ]);
         return;
      }
      logger.error(
         {
            type: 'referral_earnings_handler_error',
            handler: 'httpGetReferralEarnings',
            ...(req.requestId ? { requestId: req.requestId } : {}),
            error,
         },
         'Failed to retrieve referral earnings'
      );
      sendError(
         res,
         500,
         ErrorCode.INTERNAL_ERROR,
         'Failed to retrieve referral earnings'
      );
   }
}

/**
 * GET /api/v1/referrals/:wallet/summary
 * Total earnings, tier 1/2/3 breakdown, and referred wallet count.
 */
export async function httpGetReferralEarningsSummary(
   req: AuthenticatedRequest,
   res: Response
): Promise<void> {
   const wallet = readWalletParam(req);

   try {
      const summary = await getReferralEarningsSummary(wallet);
      sendSuccess(
         res,
         summary,
         200,
         'Referral earnings summary retrieved successfully'
      );
   } catch (error) {
      logger.error(
         {
            type: 'referral_earnings_handler_error',
            handler: 'httpGetReferralEarningsSummary',
            ...(req.requestId ? { requestId: req.requestId } : {}),
            error,
         },
         'Failed to retrieve referral earnings summary'
      );
      sendError(
         res,
         500,
         ErrorCode.INTERNAL_ERROR,
         'Failed to retrieve referral earnings summary'
      );
   }
}
