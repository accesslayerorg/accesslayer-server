import type { NextFunction, Response } from 'express';
import { ErrorCode } from '../constants/error.constants';
import { logger } from '../utils/logger.utils';
import { getBuyCooldownStatus } from '../modules/keys/key-cooldown.service';
import type { StellarSignedRequest } from './stellar-signature.middleware';

export function enforceBuyCooldown() {
   return async (
      req: StellarSignedRequest,
      res: Response,
      next: NextFunction
   ): Promise<void> => {
      const walletAddress = req.walletAddress;
      const keyId = req.params?.id ?? req.params?.keyId;

      if (!walletAddress || !keyId) {
         next();
         return;
      }

      try {
         const status = await getBuyCooldownStatus(keyId, walletAddress);
         if (!status.cooldownActive || !status.cooldownExpiresAt) {
            next();
            return;
         }

         const retryAfterSeconds = Math.max(1, status.remainingSeconds);
         res.set('Retry-After', String(retryAfterSeconds));
         res.status(429).json({
            success: false,
            error: {
               code: ErrorCode.RATE_LIMIT,
               message: 'Wallet is still within the buy cooldown for this key',
            },
            cooldown_expires_at: status.cooldownExpiresAt,
         });
         return;
      } catch (error) {
         logger.warn(
            {
               type: 'buy_cooldown_check_failed',
               walletAddress,
               keyId,
               error: error instanceof Error ? error.message : String(error),
            },
            'Buy cooldown check failed; allowing request through'
         );
         next();
      }
   };
}
