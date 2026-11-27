// src/modules/relay/relay.middleware.ts
// Middleware for enforcing the per-wallet relay rate limit (#1088).
// 10 relay requests per wallet per minute.

import type { Request, Response, NextFunction } from 'express';
import { checkRelayRateLimit } from './relay.service';
import { sendError } from '../../utils/api-response.utils';
import { ErrorCode } from '../../constants/error.constants';
import { StellarAddressSchema } from '../wallet/wallet.schemas';

export interface RelayRateLimitedRequest extends Request {
   relayWallet?: string;
}

export function relayRateLimit() {
   return async (
      req: RelayRateLimitedRequest,
      res: Response,
      next: NextFunction
   ): Promise<void> => {
      const wallet =
         req.params.wallet ??
         (req.body as Record<string, unknown> | undefined)?.wallet;

      // Non-Stellar wallet values are rejected by the route schemas with 400;
      // the rate limiter simply defers to them when the wallet is absent/invalid.
      if (
         !wallet ||
         typeof wallet !== 'string' ||
         !StellarAddressSchema.safeParse(wallet).success
      ) {
         return next();
      }

      req.relayWallet = wallet;

      const { allowed, limit, remaining, resetInSeconds } =
         await checkRelayRateLimit(wallet);

      res.setHeader('X-RateLimit-Limit', String(limit));
      res.setHeader('X-RateLimit-Remaining', String(remaining));

      if (!allowed) {
         res.setHeader('Retry-After', String(resetInSeconds));
         sendError(
            res,
            429,
            ErrorCode.RATE_LIMIT,
            'Relay rate limit exceeded: too many requests for this wallet',
            [
               {
                  field: 'wallet',
                  message: `Maximum ${limit} relay requests per wallet per minute`,
               },
            ]
         );
         return;
      }

      next();
   };
}
