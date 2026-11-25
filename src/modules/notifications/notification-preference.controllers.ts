// src/modules/notifications/notification-preference.controllers.ts
// HTTP handlers for notification preferences, verification, and unsubscribe (#1217).

import { Request, Response, NextFunction } from 'express';
import {
   sendSuccess,
   sendError,
   ErrorCode,
} from '../../utils/api-response.utils';
import { notificationPreferenceService } from './notification-preference.service';
import { UpdateNotificationPreferencesSchema } from './notification-preference.schemas';
import { StellarSignedRequest } from '../../middlewares/stellar-signature.middleware';
import { TokenError } from './notification-preference.tokens';

/**
 * PUT /v1/wallets/:address/notifications
 * Requires Stellar wallet signature matching the :address route param.
 */
export async function httpUpdateNotificationPreferences(
   req: StellarSignedRequest,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const paramAddress = req.params.address;
      const signedWallet = req.walletAddress;

      if (!signedWallet || signedWallet !== paramAddress) {
         sendError(
            res,
            403,
            ErrorCode.FORBIDDEN,
            'Signed wallet does not match the requested address'
         );
         return;
      }

      const parseResult = UpdateNotificationPreferencesSchema.safeParse(req.body);
      if (!parseResult.success) {
         sendError(
            res,
            400,
            ErrorCode.BAD_REQUEST,
            'Validation failed',
            parseResult.error.issues.map(issue => ({
               field: issue.path.join('.'),
               message: issue.message,
            }))
         );
         return;
      }

      const protocol = req.protocol || 'http';
      const host = req.get('host') || 'localhost:3000';
      const baseUrl = `${protocol}://${host}`;

      const { preference, verificationEmailSent } =
         await notificationPreferenceService.updatePreferences(
            paramAddress,
            parseResult.data,
            { baseUrl }
         );

      sendSuccess(res, {
         preference,
         verificationEmailSent,
      });
   } catch (error) {
      next(error);
   }
}

/**
 * GET /v1/wallets/:address/notifications
 * Requires Stellar wallet signature matching the :address route param.
 */
export async function httpGetNotificationPreferences(
   req: StellarSignedRequest,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const paramAddress = req.params.address;
      const signedWallet = req.walletAddress;

      if (!signedWallet || signedWallet !== paramAddress) {
         sendError(
            res,
            403,
            ErrorCode.FORBIDDEN,
            'Signed wallet does not match the requested address'
         );
         return;
      }

      const preference = await notificationPreferenceService.getPreferences(paramAddress);

      if (!preference) {
         sendError(
            res,
            404,
            ErrorCode.NOT_FOUND,
            'Notification preferences not configured for this wallet'
         );
         return;
      }

      sendSuccess(res, preference);
   } catch (error) {
      next(error);
   }
}

/**
 * GET /v1/notifications/verify?token=...
 * Verifies email verification token without login.
 */
export async function httpVerifyNotificationEmail(
   req: Request,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const token = req.query.token;
      if (!token || typeof token !== 'string') {
         sendError(
            res,
            400,
            ErrorCode.BAD_REQUEST,
            'Verification token is required as a query parameter'
         );
         return;
      }

      try {
         const preference = await notificationPreferenceService.verifyEmail(token);
         sendSuccess(res, {
            verified: true,
            wallet: preference.wallet,
            email: preference.email,
            verifiedAt: preference.verifiedAt,
            message: 'Email address verified successfully. You will now receive scheduled digest notifications.',
         });
      } catch (err) {
         if (err instanceof TokenError) {
            const statusCode =
               err.code === 'EXPIRED_TOKEN' ||
               err.code === 'INVALID_SIGNATURE' ||
               err.code === 'WRONG_PURPOSE' ||
               err.code === 'MISMATCHED_TARGET'
                  ? 400
                  : 400;

            sendError(res, statusCode, ErrorCode.BAD_REQUEST, err.message);
            return;
         }
         throw err;
      }
   } catch (error) {
      next(error);
   }
}

/**
 * GET /v1/notifications/unsubscribe?token=...
 * One-click unsubscribe disabling digests without login.
 */
export async function httpUnsubscribeNotificationDigest(
   req: Request,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const token = req.query.token;
      if (!token || typeof token !== 'string') {
         sendError(
            res,
            400,
            ErrorCode.BAD_REQUEST,
            'Unsubscribe token is required as a query parameter'
         );
         return;
      }

      try {
         const preference = await notificationPreferenceService.unsubscribe(token);
         sendSuccess(res, {
            unsubscribed: true,
            wallet: preference.wallet,
            unsubscribedAt: preference.unsubscribedAt,
            message: 'You have been successfully unsubscribed from notification digests.',
         });
      } catch (err) {
         if (err instanceof TokenError) {
            sendError(res, 400, ErrorCode.BAD_REQUEST, err.message);
            return;
         }
         throw err;
      }
   } catch (error) {
      next(error);
   }
}
