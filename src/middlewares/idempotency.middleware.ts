// src/middlewares/idempotency.middleware.ts
// Implements idempotent request handling for mutating endpoints (buy/sell).
//
// Clients send an `X-Idempotency-Key` header. The first request executes the
// handler and caches the response in Redis (24h TTL). Subsequent requests with
// the same key return the cached response without re-executing the transaction.

import { Request, Response, NextFunction } from 'express';
import { getRedisClient } from '../utils/redis.utils';
import { sendValidationError } from '../utils/api-response.utils';
import { logger } from '../utils/logger.utils';

const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60; // 24 hours
const MAX_KEY_LENGTH = 128;

export interface IdempotencyRequest extends Request {
   authWallet?: string;
}

interface CachedResponse {
   statusCode: number;
   body: unknown;
}

function resolveWallet(req: IdempotencyRequest): string {
   if (req.authWallet) return req.authWallet;
   const body = req.body as { wallet?: unknown } | undefined;
   if (body && typeof body.wallet === 'string') return body.wallet;
   return 'anonymous';
}

function buildRedisKey(wallet: string, idempotencyKey: string): string {
   return `idempotency:${wallet}:${idempotencyKey}`;
}

/**
 * Middleware factory enforcing idempotency on a route.
 *
 * - Returns 400 if the `X-Idempotency-Key` header is missing or exceeds 128 chars.
 * - Returns the cached response (status + body) if the key was seen before.
 * - Otherwise proceeds and stores the eventual response body under the key.
 */
export function idempotencyMiddleware() {
   return async (
      req: IdempotencyRequest,
      res: Response,
      next: NextFunction
   ): Promise<void> => {
      const headerValue = req.headers['x-idempotency-key'];
      const idempotencyKey =
         typeof headerValue === 'string'
            ? headerValue
            : Array.isArray(headerValue)
              ? headerValue[0]
              : undefined;

      if (!idempotencyKey || idempotencyKey.length === 0) {
         sendValidationError(res, 'X-Idempotency-Key header is required');
         return;
      }

      if (idempotencyKey.length > MAX_KEY_LENGTH) {
         sendValidationError(
            res,
            `X-Idempotency-Key must not exceed ${MAX_KEY_LENGTH} characters`
         );
         return;
      }

      const wallet = resolveWallet(req);
      const redisKey = buildRedisKey(wallet, idempotencyKey);

      try {
         const redis = await getRedisClient();
         const cached = await redis.get(redisKey);

         if (cached) {
            const parsed = JSON.parse(cached) as CachedResponse;
            logger.info(
               { type: 'idempotency_hit', redisKey },
               'Returning cached idempotent response'
            );
            res.status(parsed.statusCode).json(parsed.body);
            return;
         }

         // Wrap res.json so the response is captured and stored once.
         const originalJson = res.json.bind(res);
         res.json = ((body: unknown) => {
            const statusCode = res.statusCode || 200;
            void redis
               .set(redisKey, JSON.stringify({ statusCode, body }), {
                  EX: IDEMPOTENCY_TTL_SECONDS,
               })
               .catch((err) => {
                  logger.error(
                     { type: 'idempotency_store_error', message: err.message },
                     'Failed to store idempotency response'
                  );
               });
            return originalJson(body);
         }) as Response['json'];

         next();
      } catch (err) {
         // On Redis failure, fail open: execute the request normally.
         logger.error(
            { type: 'idempotency_error', message: (err as Error).message },
            'Idempotency check failed; proceeding without caching'
         );
         next();
      }
   };
}
