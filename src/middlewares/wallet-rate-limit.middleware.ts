// src/middlewares/wallet-rate-limit.middleware.ts
// Per-wallet sliding-window rate limiter backed by Redis.
//
// Unlike express-rate-limit's default in-memory store, this middleware keys
// on the authenticated wallet address (not IP) and uses a Redis sorted set
// per wallet so the window slides continuously rather than resetting on a
// fixed boundary. Intended for mutating, wallet-scoped endpoints such as the
// key purchase route, where a single wallet firing rapid-fire requests can
// front-run other buyers.

import type { Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import type { StellarSignedRequest } from './stellar-signature.middleware';
import { getRedis } from '../utils/redis.utils';
import { envConfig } from '../config';
import { logger } from '../utils/logger.utils';
import { sendRateLimitError } from '../utils/rate-limit-response.utils';

export interface WalletRateLimitOptions {
   /** Sliding window duration in milliseconds. */
   windowMs: number;
   /** Maximum number of requests allowed per wallet within the window. */
   max: number;
   /** Redis key prefix, namespaced per route so limits don't collide. */
   keyPrefix: string;
}

const INTERNAL_SERVICE_HEADER = 'x-internal-service-key';

function isInternalServiceCall(req: StellarSignedRequest): boolean {
   if (!envConfig.INTERNAL_SERVICE_KEY) {
      return false;
   }
   const provided = req.headers[INTERNAL_SERVICE_HEADER];
   const value = Array.isArray(provided) ? provided[0] : provided;
   return value === envConfig.INTERNAL_SERVICE_KEY;
}

/**
 * Builds a sliding-window rate limit middleware scoped to the authenticated
 * wallet address (`req.walletAddress`, set by `requireStellarSignature()`).
 *
 * Must be mounted after `requireStellarSignature()` so `walletAddress` is
 * available. Requests without a resolved wallet address are passed through
 * unlimited — signature verification is responsible for rejecting those.
 *
 * Fails open on Redis errors: a Redis outage logs a warning and allows the
 * request through rather than blocking the purchase flow.
 */
export function walletRateLimit(options: WalletRateLimitOptions) {
   const { windowMs, max, keyPrefix } = options;

   return async (
      req: StellarSignedRequest,
      res: Response,
      next: NextFunction
   ): Promise<void> => {
      if (isInternalServiceCall(req)) {
         next();
         return;
      }

      const walletAddress = req.walletAddress;
      if (!walletAddress) {
         next();
         return;
      }

      const redis = getRedis();
      if (!redis) {
         next();
         return;
      }
      const key = `${keyPrefix}${walletAddress}`;
      const now = Date.now();
      const windowStart = now - windowMs;
      const member = `${now}-${randomUUID()}`;

      try {
         const pipeline = redis.pipeline();
         pipeline.zremrangebyscore(key, 0, windowStart);
         pipeline.zadd(key, now, member);
         pipeline.zcard(key);
         pipeline.pexpire(key, windowMs);
         const results = await pipeline.exec();

         const countResult = results?.[2];
         const count =
            countResult && !countResult[0] ? (countResult[1] as number) : 0;

         if (count > max) {
            const retryAfterSeconds = Math.ceil(windowMs / 1000);
            logger.warn(
               {
                  type: 'rate_limit_breach',
                  walletAddress,
                  route: req.path,
                  limit: max,
                  windowMs,
                  timestamp: new Date(now).toISOString(),
               },
               'Wallet exceeded rate limit'
            );
            sendRateLimitError(res, retryAfterSeconds);
            return;
         }

         next();
      } catch (error) {
         logger.error(
            { error, walletAddress, route: req.path },
            'Rate limit check failed; allowing request through (fail open)'
         );
         next();
      }
   };
}

/**
 * Rate limit applied to the key purchase (buy) endpoint: 5 requests per
 * 10-second sliding window per wallet.
 */
export const buyKeyRateLimit = walletRateLimit({
   windowMs: 10_000,
   max: 5,
   keyPrefix: 'rl:buy:',
});
