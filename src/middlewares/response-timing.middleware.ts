// src/middlewares/response-timing.middleware.ts
import { Request, Response, NextFunction } from 'express';
import { envConfig } from '../config';
import { startTimer, elapsedMsFormatted } from '../utils/monotonic-clock.utils';

/**
 * Middleware that adds an `X-Response-Time` header to the response.
 *
 * Uses a monotonic clock (`process.hrtime`) so the measurement is not
 * affected by system clock adjustments.
 *
 * Can be enabled/disabled via the `ENABLE_RESPONSE_TIMING` environment variable.
 */
export const responseTimingMiddleware = (
   _req: Request,
   res: Response,
   next: NextFunction
): void => {
   if (!envConfig.ENABLE_RESPONSE_TIMING) {
      return next();
   }

   const timer = startTimer();

   // Intercept the response headers being sent
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

   next();
};
