import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger.utils';

// Log request outcome after the response has been fully sent.
//
// Emits a structured log with:
// - request_id
// - method
// - path
// - status_code
// - response_time_ms
//
// Log level rules:
// - error for 5xx responses
// - warn when response time exceeds 1000ms
// - info otherwise
export const requestCompletionLoggerMiddleware = (
   req: Request,
   res: Response,
   next: NextFunction
): void => {
   const startTime = process.hrtime();
   let logged = false;

   const requestId = (req as any).requestId as string | undefined;

   // Ensure we log once even if multiple events fire.
   const logOnce = () => {
      if (logged) return;
      logged = true;

      const diff = process.hrtime(startTime);
      const responseTimeMs = diff[0] * 1e3 + diff[1] * 1e-6;

      const statusCode = res.statusCode;
      const path = req.path;
      const method = req.method;

      const payload = {
         request_id: requestId,
         method,
         path,
         status_code: statusCode,
         response_time_ms: Math.round(responseTimeMs),
      };

      if (statusCode >= 500) {
         logger.error(payload, 'Request completed');
         return;
      }

      if (responseTimeMs > 1000) {
         logger.warn(payload, 'Request completed');
         return;
      }

      logger.info(payload, 'Request completed');
   };

   res.once('finish', logOnce);
   res.once('close', logOnce);

   next();
};
