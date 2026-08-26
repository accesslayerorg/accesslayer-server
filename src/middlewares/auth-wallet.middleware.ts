// src/middlewares/auth-wallet.middleware.ts
// Verifies a JWT bearer token and attaches the authenticated wallet address
// to the request. Used to enforce that a caller owns the resource they are
// requesting (e.g. their own referrals or holdings).

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { envConfig } from '../config';
import { sendUnauthorized } from '../utils/api-response.utils';

export interface WalletAuthRequest extends Request {
   authWallet?: string;
}

/**
 * Express middleware that requires a valid JWT whose `wallet` claim matches the
 * expectations of the downstream handler. On success the resolved wallet is
 * attached to `req.authWallet`.
 *
 * Returns 401 when the Authorization header is missing, malformed, or the
 * token fails verification.
 */
export function requireWalletAuth(
   req: WalletAuthRequest,
   res: Response,
   next: NextFunction
): void {
   const header = req.headers['authorization'];
   if (!header || typeof header !== 'string') {
      return sendUnauthorized(res, 'Authorization header is required');
   }

   const [scheme, token] = header.split(' ');
   if (scheme !== 'Bearer' || !token) {
      return sendUnauthorized(res, 'Bearer token is required');
   }

   try {
      const payload = jwt.verify(token, envConfig.APP_SECRET) as {
         wallet?: string;
      };
      if (!payload.wallet || typeof payload.wallet !== 'string') {
         return sendUnauthorized(res, 'Token is missing the wallet claim');
      }
      req.authWallet = payload.wallet;
      next();
   } catch {
      return sendUnauthorized(res, 'Invalid or expired token');
   }
}
