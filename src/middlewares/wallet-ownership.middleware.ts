// src/middlewares/wallet-ownership.middleware.ts
// Express middleware that gates a route on Stellar wallet ownership of the
// resource named by a path parameter. Backed by
// `utils/wallet-ownership.utils.ts` so the same check can be invoked from
// handlers when middleware composition is awkward.
//
// The caller's wallet address is read from the `x-wallet-address` header.
// Once an authenticated session layer lands this middleware should be wired
// to read from `req.user` instead — the helper takes a plain address either
// way.

import { Request, Response, NextFunction } from 'express';
import { checkCreatorProfileOwnership } from '../utils/wallet-ownership.utils';
import { ErrorCode, sendError } from '../utils/api-response.utils';

export interface WalletOwnedRequest extends Request {
   walletAddress?: string;
   ownerUserId?: string;
}

/**
 * Pull the Stellar wallet address from the `x-wallet-address` header.
 * Accepts the first value when the header was duplicated.
 */
function readWalletAddress(req: Request): string | undefined {
   const raw = req.headers['x-wallet-address'];
   if (Array.isArray(raw)) {
      return raw[0]?.trim() || undefined;
   }
   return typeof raw === 'string' ? raw.trim() || undefined : undefined;
}

/**
 * Produce middleware that enforces wallet ownership of the creator profile
 * named by `params[paramName]` (defaults to `creatorId`). On success the
 * caller's wallet address and the resolved owner user id are attached to the
 * request for downstream handlers.
 */
export function requireCreatorProfileOwnership(
   paramName: string = 'creatorId'
) {
   return async (
      req: WalletOwnedRequest,
      res: Response,
      next: NextFunction
   ): Promise<void> => {
      const address = readWalletAddress(req);
      if (!address) {
         sendError(
            res,
            401,
            ErrorCode.UNAUTHORIZED,
            'Wallet address is required to access this resource. Send it in the x-wallet-address header.'
         );
         return;
      }

      const rawParam = req.params[paramName];
      const creatorIdOrHandle = Array.isArray(rawParam)
         ? rawParam[0]
         : rawParam;
      if (!creatorIdOrHandle) {
         sendError(
            res,
            400,
            ErrorCode.BAD_REQUEST,
            `Missing required path parameter "${paramName}".`
         );
         return;
      }

      try {
         const verdict = await checkCreatorProfileOwnership(
            address,
            creatorIdOrHandle
         );

         if (verdict.status === 'wallet_not_found') {
            sendError(
               res,
               401,
               ErrorCode.UNAUTHORIZED,
               'Wallet address is not registered. Map your wallet to a user before accessing gated resources.'
            );
            return;
         }

         if (verdict.status === 'forbidden') {
            sendError(
               res,
               403,
               ErrorCode.FORBIDDEN,
               'Wallet does not own the requested resource.'
            );
            return;
         }

         req.walletAddress = address;
         req.ownerUserId = verdict.ownerUserId;
         next();
      } catch (error) {
         console.error('wallet-ownership check failed:', error);
         sendError(
            res,
            500,
            ErrorCode.INTERNAL_ERROR,
            'Failed to verify wallet ownership.'
         );
      }
   };
}
