// src/middlewares/response-timing.middleware.ts
import { Request, Response, NextFunction } from 'express';
import { envConfig } from '../config';
import { logger } from '../utils/logger.utils';
import {
   startTimer,
   elapsedMs,
   elapsedMsFormatted,
} from '../utils/monotonic-clock.utils';
import {
   extractBearerToken,
   verifyWalletAccessToken,
} from '../utils/jwt.utils';

export interface ResponseTimingOptions {
   /**
    * Override the threshold in milliseconds above which a warn-level log is emitted.
    * Defaults to envConfig.SLOW_REQUEST_THRESHOLD_MS (or 2000).
    */
   slowThresholdMs?: number;
   /**
    * Override whether to inject the X-Response-Time header on writeHead.
    * Defaults to envConfig.ENABLE_RESPONSE_TIMING.
    */
   enableResponseTiming?: boolean;
}

export interface SlowRequestLogPayload {
   method: string;
   path: string;
   status_code: number;
   duration_ms: number;
   slow_threshold_ms: number;
   wallet?: string;
}

/**
 * Best-effort extraction of authenticated wallet address from the request.
 * Checks request user/wallet properties, headers, and Bearer JWTs.
 */
export function resolveAuthenticatedWallet(req: Request): string | undefined {
   if (
      (req as any).user?.wallet &&
      typeof (req as any).user.wallet === 'string'
   ) {
      return (req as any).user.wallet;
   }
   if (
      (req as any).walletAddress &&
      typeof (req as any).walletAddress === 'string'
   ) {
      return (req as any).walletAddress;
   }
   if ((req as any).wallet && typeof (req as any).wallet === 'string') {
      return (req as any).wallet;
   }
   if (typeof req.headers?.['x-wallet-address'] === 'string') {
      return req.headers['x-wallet-address'];
   }
   const authHeader = req.headers?.authorization;
   const token = extractBearerToken(authHeader);
   if (token) {
      try {
         return verifyWalletAccessToken(token).wallet;
      } catch {
         // Ignore invalid tokens during best-effort extraction
      }
   }
   return undefined;
}

/**
 * Factory that creates the response timing and slow request logging middleware.
 */
export function createResponseTimingMiddleware(
   options?: ResponseTimingOptions
) {
   return (req: Request, res: Response, next: NextFunction): void => {
      const timer = startTimer();
      const enableTiming =
         options?.enableResponseTiming ?? envConfig.ENABLE_RESPONSE_TIMING;
      const slowThreshold =
         options?.slowThresholdMs ??
         envConfig.SLOW_REQUEST_THRESHOLD_MS ??
         2000;

      // Intercept response headers being sent to inject X-Response-Time
      if (enableTiming && typeof res.writeHead === 'function') {
         const originalWriteHead = res.writeHead;

         res.writeHead = function (
            statusCode: number,
            reasonOrHeaders?: string | any,
            headers?: any
         ) {
            res.setHeader('X-Response-Time', elapsedMsFormatted(timer));

            return originalWriteHead.apply(this, [
               statusCode,
               reasonOrHeaders,
               headers,
            ] as any);
         };
      }

      let logged = false;
      const onFinish = () => {
         if (logged) return;
         logged = true;

         const durationMs = elapsedMs(timer);

         if (durationMs > slowThreshold) {
            const wallet = resolveAuthenticatedWallet(req);
            const path = req.originalUrl
               ? req.originalUrl.split('?')[0]
               : req.baseUrl
                 ? req.baseUrl + req.path
                 : req.path;

            const payload: SlowRequestLogPayload = {
               method: req.method,
               path,
               status_code: res.statusCode,
               duration_ms: Math.round(durationMs),
               slow_threshold_ms: slowThreshold,
            };

            if (wallet) {
               payload.wallet = wallet;
            }

            logger.warn(payload, 'Slow request detected');
         }
      };

      if (typeof res.once === 'function') {
         res.once('finish', onFinish);
         res.once('close', onFinish);
      } else if (typeof res.on === 'function') {
         res.on('finish', onFinish);
         res.on('close', onFinish);
      }

      next();
   };
}

/**
 * Middleware that adds an `X-Response-Time` header to the response and
 * emits a structured warn-level log when the request duration exceeds
 * the configured response time threshold (`SLOW_REQUEST_THRESHOLD_MS`, default 2000ms).
 *
 * Uses a monotonic clock (`process.hrtime`) so measurement is immune to system clock shifts.
 */
export const responseTimingMiddleware = createResponseTimingMiddleware();
