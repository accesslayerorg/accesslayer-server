// src/modules/referrals/referral-tier.controller.ts
// Handlers for the referral tier endpoints (#1034):
//   GET /api/v1/referrals/tier
//   GET /api/v1/referrals/tier/history
//
// Both are wallet-scoped via the `wallet` query parameter; the JWT wallet must
// match it (see `requireWalletQueryMatch`).

import { Response } from 'express';
import {
   ErrorCode,
   sendError,
   sendSuccess,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import { attachTimestampHeader } from '../../utils/timestamp-headers.utils';
import { logger } from '../../utils/logger.utils';
import { CursorChecksumError } from '../../utils/cursor.utils';
import { AuthenticatedRequest } from '../../middlewares/jwt-auth.middleware';
import {
   ReferralTierHistoryQuerySchema,
   ReferralTierQuerySchema,
} from './referral-tier.schemas';
import {
   getReferralTierHistory,
   getReferralTierSnapshot,
} from './referral-tier.service';

/**
 * GET /api/v1/referrals/tier?wallet=
 * Current tier, cumulative volume, next threshold and reward rate (bps).
 */
export async function httpGetReferralTier(
   req: AuthenticatedRequest,
   res: Response
): Promise<void> {
   const parsed = ReferralTierQuerySchema.safeParse(req.query);
   if (!parsed.success) {
      sendValidationError(
         res,
         'Invalid query parameters',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }

   try {
      const snapshot = await getReferralTierSnapshot(parsed.data.wallet);
      attachTimestampHeader(res);
      sendSuccess(res, snapshot, 200, 'Referral tier retrieved successfully');
   } catch (error) {
      logger.error(
         {
            type: 'referral_tier_handler_error',
            handler: 'httpGetReferralTier',
            ...(req.requestId ? { requestId: req.requestId } : {}),
            error,
         },
         'Failed to retrieve referral tier'
      );
      sendError(
         res,
         500,
         ErrorCode.INTERNAL_ERROR,
         'Failed to retrieve referral tier'
      );
   }
}

/**
 * GET /api/v1/referrals/tier/history?wallet=&limit=&cursor=
 * Cursor-paginated tier upgrade history for a wallet, newest first.
 */
export async function httpGetReferralTierHistory(
   req: AuthenticatedRequest,
   res: Response
): Promise<void> {
   const parsed = ReferralTierHistoryQuerySchema.safeParse(req.query);
   if (!parsed.success) {
      sendValidationError(
         res,
         'Invalid query parameters',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }

   try {
      const page = await getReferralTierHistory(parsed.data.wallet, {
         limit: parsed.data.limit,
         cursor: parsed.data.cursor,
      });
      attachTimestampHeader(res);
      sendSuccess(res, page, 200, 'Referral tier history retrieved successfully');
   } catch (error) {
      if (error instanceof CursorChecksumError) {
         sendValidationError(res, 'Invalid cursor', [
            { field: 'cursor', message: error.message },
         ]);
         return;
      }
      logger.error(
         {
            type: 'referral_tier_handler_error',
            handler: 'httpGetReferralTierHistory',
            ...(req.requestId ? { requestId: req.requestId } : {}),
            error,
         },
         'Failed to retrieve referral tier history'
      );
      sendError(
         res,
         500,
         ErrorCode.INTERNAL_ERROR,
         'Failed to retrieve referral tier history'
      );
   }
}
