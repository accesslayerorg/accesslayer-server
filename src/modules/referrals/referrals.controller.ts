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
import { ReferredWalletsQuerySchema, RegisterReferralSchema } from './referrals.schemas';
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
