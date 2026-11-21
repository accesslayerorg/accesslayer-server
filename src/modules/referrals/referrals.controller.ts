// src/modules/referrals/referrals.controller.ts
// Handlers for the referral programme endpoints (#910):
//   POST /api/v1/referrals/register
//   GET  /api/v1/referrals/earnings
//   GET  /api/v1/referrals/referred
//
// All three require a JWT; the wallet is always taken from the token, never
// from the request body, so a caller can only act on its own referral data.

import { Response } from 'express';
import {
   ErrorCode,
   sendError,
   sendSuccess,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import { attachTimestampHeader } from '../../utils/timestamp-headers.utils';
import { CursorChecksumError } from '../../utils/cursor.utils';
import { logger } from '../../utils/logger.utils';
import { AuthenticatedRequest } from '../../middlewares/jwt-auth.middleware';
import {
   ReferralClaimSchema,
   ReferralWalletQuerySchema,
   ReferredWalletsQuerySchema,
   RegisterReferralSchema,
} from './referrals.schemas';
import {
   buildReferralClaimTransaction,
   getPendingReferralRewards,
   getReferralHistory,
   NothingToClaimError,
   ReferralContractUnavailableError,
   ReferralKeyNotFoundError,
} from './referrals-api.service';
import { prisma } from '../../utils/prisma.utils';
import {
   AlreadyReferredError,
   getReferralEarnings,
   listReferredWallets,
   ReferralCodeNotFoundError,
   registerReferral,
   SelfReferralError,
} from './referrals.service';

/**
 * POST /api/v1/referrals/register
 *
 * Links the authenticated wallet (the referee) to the wallet that owns
 * `referralCode` (the referrer). A wallet can only be referred once, so a
 * second registration returns 409.
 */
export async function httpRegisterReferral(
   req: AuthenticatedRequest,
   res: Response
): Promise<void> {
   try {
      const parsed = RegisterReferralSchema.safeParse(req.body);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid request body',
            zodIssuesToDetails(parsed.error.issues)
         );
         return;
      }

      const registered = await registerReferral(
         req.user!.wallet,
         parsed.data.referralCode
      );

      attachTimestampHeader(res);
      sendSuccess(
         res,
         registered,
         201,
         'Referral registered successfully'
      );
   } catch (error) {
      if (error instanceof ReferralCodeNotFoundError) {
         sendError(res, 404, ErrorCode.NOT_FOUND, error.message);
         return;
      }
      if (error instanceof SelfReferralError) {
         sendError(res, 400, ErrorCode.BAD_REQUEST, error.message);
         return;
      }
      if (error instanceof AlreadyReferredError) {
         sendError(res, 409, ErrorCode.CONFLICT, error.message);
         return;
      }
      logger.error(
         {
            type: 'referral_register_failed',
            ...(req.requestId ? { requestId: req.requestId } : {}),
            error,
         },
         'Failed to register referral'
      );
      sendError(res, 500, ErrorCode.INTERNAL_ERROR, 'Failed to register referral');
   }
}

/**
 * GET /api/v1/referrals/earnings
 *
 * Total XLM earned from referrals, the wallet's own referral code, and a
 * per-referral breakdown of what each referred wallet has paid out.
 */
export async function httpGetReferralEarnings(
   req: AuthenticatedRequest,
   res: Response
): Promise<void> {
   try {
      const parsed = ReferredWalletsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid query parameters',
            zodIssuesToDetails(parsed.error.issues)
         );
         return;
      }

      const earnings = await getReferralEarnings(req.user!.wallet, parsed.data);

      attachTimestampHeader(res);
      sendSuccess(
         res,
         earnings,
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
            type: 'referral_earnings_failed',
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
 * GET /api/v1/referrals/referred
 *
 * Cursor-paginated list of the wallets referred by the authenticated wallet,
 * each with its join date and whether it has completed its first trade.
 */
export async function httpGetReferredWallets(
   req: AuthenticatedRequest,
   res: Response
): Promise<void> {
   try {
      const parsed = ReferredWalletsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid query parameters',
            zodIssuesToDetails(parsed.error.issues)
         );
         return;
      }

      const page = await listReferredWallets(req.user!.wallet, parsed.data);

      attachTimestampHeader(res);
      sendSuccess(
         res,
         {
            referred: page.items,
            totalCount: page.items.length,
            pagination: {
               limit: parsed.data.limit,
               nextCursor: page.next_cursor,
               hasMore: page.has_more,
            },
         },
         200,
         'Referred wallets retrieved successfully'
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
            type: 'referral_referred_list_failed',
            ...(req.requestId ? { requestId: req.requestId } : {}),
            error,
         },
         'Failed to retrieve referred wallets'
      );
      sendError(
         res,
         500,
         ErrorCode.INTERNAL_ERROR,
         'Failed to retrieve referred wallets'
      );
   }
}

function walletFromQuery(req: AuthenticatedRequest, requestedWallet?: string): string | null {
   const authenticatedWallet = req.user!.wallet;
   if (requestedWallet && requestedWallet !== authenticatedWallet) return null;
   return authenticatedWallet;
}

/** GET /api/v1/referrals/stats?wallet=... */
export async function httpGetReferralStats(
   req: AuthenticatedRequest,
   res: Response
): Promise<void> {
   try {
      const parsed = ReferralWalletQuerySchema.safeParse(req.query);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid query parameters',
            zodIssuesToDetails(parsed.error.issues)
         );
         return;
      }
      const wallet = walletFromQuery(req, parsed.data.wallet);
      if (!wallet) {
         sendError(
            res,
            403,
            ErrorCode.FORBIDDEN,
            'Wallet does not match the authenticated account'
         );
         return;
      }

      const [totalReferees, earned, pendingRewards] = await Promise.all([
         prisma.referral.count({ where: { referrerAddress: wallet } }),
         prisma.referralEvent.aggregate({
            where: { walletAddress: wallet },
            _sum: { amount: true },
         }),
         getPendingReferralRewards(wallet),
      ]);

      attachTimestampHeader(res);
      sendSuccess(res, {
         wallet,
         totalReferees,
         totalEarned: Number(earned._sum.amount ?? 0),
         pendingRewards,
      });
   } catch (error) {
      if (error instanceof ReferralContractUnavailableError) {
         sendError(res, 503, ErrorCode.SERVICE_UNAVAILABLE, error.message);
         return;
      }
      logger.error({ type: 'referral_stats_failed', error }, 'Failed to retrieve referral stats');
      sendError(res, 500, ErrorCode.INTERNAL_ERROR, 'Failed to retrieve referral stats');
   }
}

/** GET /api/v1/referrals/history?wallet=... */
export async function httpGetReferralHistory(
   req: AuthenticatedRequest,
   res: Response
): Promise<void> {
   try {
      const parsed = ReferralWalletQuerySchema.safeParse(req.query);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid query parameters',
            zodIssuesToDetails(parsed.error.issues)
         );
         return;
      }
      const wallet = walletFromQuery(req, parsed.data.wallet);
      if (!wallet) {
         sendError(
            res,
            403,
            ErrorCode.FORBIDDEN,
            'Wallet does not match the authenticated account'
         );
         return;
      }

      const page = await getReferralHistory(wallet, parsed.data);
      attachTimestampHeader(res);
      sendSuccess(res, {
         wallet,
         events: page.items,
         pagination: {
            limit: parsed.data.limit,
            nextCursor: page.nextCursor,
            hasMore: page.nextCursor !== null,
         },
      });
   } catch (error) {
      if (error instanceof CursorChecksumError) {
         sendValidationError(res, 'Invalid cursor', [{ field: 'cursor', message: error.message }]);
         return;
      }
      logger.error(
         { type: 'referral_history_failed', error },
         'Failed to retrieve referral history'
      );
      sendError(res, 500, ErrorCode.INTERNAL_ERROR, 'Failed to retrieve referral history');
   }
}

/** POST /api/v1/referrals/claim */
export async function httpBuildReferralClaim(
   req: AuthenticatedRequest,
   res: Response
): Promise<void> {
   try {
      const parsed = ReferralClaimSchema.safeParse(req.body);
      if (!parsed.success) {
         sendValidationError(res, 'Invalid request body', zodIssuesToDetails(parsed.error.issues));
         return;
      }
      const result = await buildReferralClaimTransaction({
         wallet: req.user!.wallet,
         keyId: parsed.data.keyId,
      });
      attachTimestampHeader(res);
      sendSuccess(res, result, 201, 'Unsigned referral claim transaction built successfully');
   } catch (error) {
      if (error instanceof ReferralKeyNotFoundError) {
         sendError(res, 404, ErrorCode.NOT_FOUND, error.message);
         return;
      }
      if (error instanceof NothingToClaimError) {
         sendError(res, 400, ErrorCode.BAD_REQUEST, error.message);
         return;
      }
      if (error instanceof ReferralContractUnavailableError) {
         sendError(res, 503, ErrorCode.SERVICE_UNAVAILABLE, error.message);
         return;
      }
      logger.error(
         { type: 'referral_claim_build_failed', error },
         'Failed to build referral claim transaction'
      );
      sendError(res, 500, ErrorCode.INTERNAL_ERROR, 'Failed to build referral claim transaction');
   }
}
