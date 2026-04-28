// src/middlewares/request-logger.middleware.ts
import { Request, Response, NextFunction } from 'express';
import { envConfig } from '../config';
import { logger } from '../utils/logger.utils';
import { computeRequestContextHash } from '../utils/request-context-hash.utils';

/**
 * Lightweight request logging middleware.
 *
 * Logs essential request metadata:
 * - Method
 * - Path (URL)
 * - Status Code
 * - Response Duration
 * - Request ID (for correlation)
 *
 * It avoids logging sensitive data like headers or request bodies.
 */
export const requestLoggerMiddleware = (
   req: Request,
   res: Response,
   next: NextFunction
): void => {
   if (!envConfig.ENABLE_REQUEST_LOGGING) {
      return next();
   }

   const start = process.hrtime();
   const contextHash = computeRequestContextHash(req);

   res.on('finish', () => {
      const diff = process.hrtime(start);
      const durationMs = (diff[0] * 1e3 + diff[1] * 1e-6).toFixed(3);

      logger.info({
         type: 'request',
         method: req.method,
         url: req.originalUrl || req.url,
         status: res.statusCode,
         duration: `${durationMs}ms`,
         requestId: req.requestId,
         contextHash,
      });
   });

   next();
};
