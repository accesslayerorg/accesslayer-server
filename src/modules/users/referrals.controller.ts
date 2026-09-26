// src/modules/users/referrals.controller.ts
// Handler + cache plumbing for GET /api/v1/users/:wallet/referrals.
//
// The summary (totalEarned, referralCount) is cached in Redis for 2 minutes.
// The breakdown page is always computed fresh so cursor pagination stays
// consistent. `handleReferralFeePaidEvent` persists the event and busts the
// cached summary — wire it into the indexer's event processing path.

import { Response } from 'express';
import {
   ErrorCode,
   sendError,
   sendSuccess,
   sendValidationError,
} from '../../utils/api-response.utils';
import { attachTimestampHeader } from '../../utils/timestamp-headers.utils';
import {
   cacheGetJson,
   cacheSetJson,
   cacheInvalidate,
} from '../../utils/redis.utils';
import { logger } from '../../utils/logger.utils';
import { CursorChecksumError } from '../../utils/cursor.utils';
import { AuthenticatedRequest } from '../../middlewares/jwt-auth.middleware';
import {
   buildReferralSummaryCacheKey,
   REFERRAL_SUMMARY_CACHE_TTL_SECONDS,
} from './referrals.constants';
import { ReferralBreakdownQuerySchema } from './referrals.schemas';
import {
   getReferralBreakdown,
   getReferralSummary,
   recordReferralEvent,
} from './referrals.service';

export async function httpGetWalletReferrals(
   req: AuthenticatedRequest,
   res: Response
): Promise<void> {
   try {
      const wallet = (
         Array.isArray(req.params.wallet)
            ? req.params.wallet[0]
            : req.params.wallet
      ).trim();

      const parsed = ReferralBreakdownQuerySchema.safeParse(req.query);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid query parameters',
            parsed.error.issues.map(issue => ({
               field: issue.path.join('.'),
               message: issue.message,
            }))
         );
         return;
      }

      const cacheKey = buildReferralSummaryCacheKey(wallet);
      let summary = await cacheGetJson<{
         totalEarned: number;
         referralCount: number;
      }>(cacheKey);

      if (!summary) {
         summary = await getReferralSummary(wallet);
         await cacheSetJson(
            cacheKey,
            summary,
            REFERRAL_SUMMARY_CACHE_TTL_SECONDS
         );
      }

      const breakdown = await getReferralBreakdown(wallet, parsed.data);

      attachTimestampHeader(res);
      sendSuccess(
         res,
         {
            ...summary,
            breakdown: breakdown.items,
            pagination: {
               limit: parsed.data.limit,
               nextCursor: breakdown.nextCursor,
               hasMore: breakdown.nextCursor !== null,
            },
         },
         200,
         'Referral earnings retrieved successfully'
      );
   } catch (error) {
      if (error instanceof CursorChecksumError) {
         sendValidationError(res, 'Invalid cursor', [
            { field: 'cursor', message: error.message },
         ]);
         return;
      }
      logger.error(
         {
            type: 'referrals_handler_error',
            handler: 'httpGetWalletReferrals',
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
 * Invalidate the cached referral summary for a wallet. Called automatically
 * by {@link handleReferralFeePaidEvent}; also safe to call directly wherever
 * referral state changes.
 */
export async function invalidateReferralSummaryCache(
   wallet: string
): Promise<void> {
   await cacheInvalidate(buildReferralSummaryCacheKey(wallet));
}

/**
 * Persist an on-chain `referral_fee_paid` event and immediately invalidate
 * the wallet's cached summary so profile pages see the new earnings within
 * the same request cycle rather than waiting out the 2-minute TTL.
 */
export async function handleReferralFeePaidEvent(event: {
   walletAddress: string;
   keyId: string;
   creatorId?: string | null;
   amount: number;
   txHash?: string | null;
   eventIndex?: number | null;
   createdAt?: Date;
}): Promise<void> {
   await recordReferralEvent(event);
   await invalidateReferralSummaryCache(event.walletAddress);
}
