// src/modules/nonce/nonce.middleware.ts
// Middleware for enforcing single-use nonce validation on signed action endpoints (#1039).

import type { Request, Response, NextFunction } from 'express';
import {
   validateSignedActionNonce,
   NonceAlreadyConsumedError,
   NonceMismatchError,
} from './nonce.service';
import {
   sendConflict,
   sendError,
   sendValidationError,
} from '../../utils/api-response.utils';
import { ErrorCode } from '../../constants/error.constants';
import { StellarAddressSchema } from '../wallet/wallet.schemas';

export interface NonceProtectedRequest extends Request {
   walletAddress?: string;
   user?: { wallet?: string };
}

export interface NonceMiddlewareOptions {
   action?: string;
   /**
    * If false, allows requests that omit the nonce to proceed without validation.
    * If true, requires a nonce either in header `x-nonce` or in `req.body.nonce`.
    * Default is false (optional nonce, validated if present).
    */
   required?: boolean;
}

/**
 * Middleware that validates single-use nonces for replay-protected signed actions.
 * Extracts wallet from `req.walletAddress`, `req.user.wallet`, `req.body.signer`, or `req.body.wallet`.
 * Rejects replayed nonces immediately with HTTP 409 Conflict.
 */
export function requireNonceReplayProtection(
   options: NonceMiddlewareOptions = {}
) {
   return async (
      req: NonceProtectedRequest,
      res: Response,
      next: NextFunction
   ): Promise<void> => {
      const headerNonce = req.headers['x-nonce'];
      const rawNonce =
         headerNonce !== undefined
            ? Array.isArray(headerNonce)
               ? headerNonce[0]
               : headerNonce
            : (req.body as any)?.nonce;

      if (rawNonce === undefined || rawNonce === null || rawNonce === '') {
         if (options.required) {
            sendValidationError(
               res,
               'Nonce is required for this signed action',
               [
                  {
                     field: 'nonce',
                     message: 'x-nonce header or body.nonce is required',
                  },
               ]
            );
            return;
         }
         next();
         return;
      }

      const nonceNum = Number(rawNonce);
      if (!Number.isInteger(nonceNum) || nonceNum < 0) {
         sendValidationError(res, 'Invalid nonce value', [
            { field: 'nonce', message: 'nonce must be a non-negative integer' },
         ]);
         return;
      }

      const wallet =
         req.walletAddress ||
         req.user?.wallet ||
         (req.body as any)?.signer ||
         (req.body as any)?.wallet;

      if (!wallet) {
         sendError(
            res,
            400,
            ErrorCode.BAD_REQUEST,
            'Cannot validate nonce: wallet address could not be determined'
         );
         return;
      }

      const walletCheck = StellarAddressSchema.safeParse(wallet);
      if (!walletCheck.success) {
         sendValidationError(
            res,
            'Invalid wallet address for nonce validation',
            [{ field: 'wallet', message: walletCheck.error.issues[0].message }]
         );
         return;
      }

      try {
         await validateSignedActionNonce(wallet, nonceNum, options.action);
         next();
      } catch (error) {
         if (error instanceof NonceAlreadyConsumedError) {
            sendConflict(res, error.message);
            return;
         }
         if (error instanceof NonceMismatchError) {
            sendError(res, 400, ErrorCode.BAD_REQUEST, error.message);
            return;
         }
         next(error);
      }
   };
}
