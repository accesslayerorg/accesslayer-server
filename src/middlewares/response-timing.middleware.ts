// src/middlewares/response-timing.middleware.ts
import { Request, Response, NextFunction } from 'express';
import { envConfig } from '../config';

/**
 * Middleware that adds an `X-Response-Time` header to the response.
 *
 * It calculates the time elapsed from the beginning of the request
 * until the response is sent to the client.
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

   const start = process.hrtime();

   // Intercept the response headers being sent
   const originalWriteHead = res.writeHead;

   res.writeHead = function (
      statusCode: number,
      reasonOrHeaders?: string | any,
      headers?: any
   ) {
      const diff = process.hrtime(start);
      const timeInMs = (diff[0] * 1e3 + diff[1] * 1e-6).toFixed(3);

      // Set the header before the original writeHead is called
      res.setHeader('X-Response-Time', `${timeInMs}ms`);

      return originalWriteHead.apply(this, [
         statusCode,
         reasonOrHeaders,
         headers,
      ] as any);
   };

   next();
};
