// src/middlewares/trade-nonce.middleware.ts
// Middleware to verify and atomically consume single-use trade nonces (#1194).

import type { Response, NextFunction } from 'express';
import type { StellarSignedRequest } from './stellar-signature.middleware';
import { ErrorCode } from '../constants/error.constants';
import { sendError } from '../utils/api-response.utils';
import { consumeNonce } from '../modules/trading/nonce.service';
import { logger } from '../utils/logger.utils';

function readHeader(req: StellarSignedRequest, name: string): string | undefined {
   const raw = req.headers[name];
   if (Array.isArray(raw)) return raw[0]?.trim() || undefined;
   return typeof raw === 'string' ? raw.trim() || undefined : undefined;
}

/**
 * Middleware that validates that the request contains a valid, unexpired,
 * single-use nonce for the signing wallet and consumes it atomically.
 *
 * Expired or already-used nonces reject with HTTP 401 and code `nonce_invalid`.
 */
export function enforceTradeNonce() {
   return async (
      req: StellarSignedRequest,
      res: Response,
      next: NextFunction
   ): Promise<void> => {
      const walletAddress = req.walletAddress || readHeader(req, 'x-wallet-address');
      const nonce = req.body?.nonce;

      if (!walletAddress) {
         sendError(
            res,
            401,
            ErrorCode.UNAUTHORIZED,
            'Missing signing wallet address'
         );
         return;
      }

      if (!nonce || typeof nonce !== 'string' || !nonce.trim()) {
         sendError(
            res,
            401,
            ErrorCode.NONCE_INVALID,
            'Missing or invalid trade nonce'
         );
         return;
      }

      const consumed = await consumeNonce(walletAddress, nonce.trim());
      if (!consumed) {
         logger.warn(
            {
               wallet: walletAddress,
               nonce,
               endpoint: req.originalUrl || req.path,
               requestId: req.requestId,
            },
            'Trade rejected due to invalid, expired, or reused nonce'
         );
         sendError(
            res,
            401,
            ErrorCode.NONCE_INVALID,
            'Invalid or expired nonce'
         );
         return;
      }

      next();
   };
}
