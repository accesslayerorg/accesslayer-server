import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger.utils';
import { envConfig } from '../config';

interface AuthenticatedRequest extends Request {
   user?: {
      wallet: string;
   };
}

// Log request outcome after the response has been fully sent.
//
// Emits a structured log with:
// - request_id
// - method
// - route (parametrised, e.g. /api/v1/creators/:id)
// - status_code
// - response_time_ms
//
// The route field uses the matched Express route pattern (req.route.path)
// so log keys are low-cardinality. Falls back to the raw path when no
// route matches (e.g. 404s).
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
      const method = req.method;

      // Use the parametrised Express route pattern when available to avoid
      // high-cardinality log keys. Falls back to req.path for unmatched
      // routes (e.g. 404s).
      const route = req.route
         ? req.baseUrl + req.route.path
         : req.baseUrl + req.path;

      const payload = {
         request_id: requestId,
         method,
         route,
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

export const slowRequestLoggerMiddleware = (
   req: AuthenticatedRequest,
   res: Response,
   next: NextFunction
): void => {
   const startTime = process.hrtime();
   let logged = false;

   // Ensure we log once even if multiple events fire.
   const logOnce = () => {
      if (logged) return;
      logged = true;

      const diff = process.hrtime(startTime);
      const durationMs = diff[0] * 1e3 + diff[1] * 1e-6;

      if (durationMs >= envConfig.SLOW_REQUEST_THRESHOLD_MS) {
         const wallet = req.user?.wallet;
         const payload = {
            method: req.method,
            path: req.path,
            status_code: res.statusCode,
            duration_ms: Math.round(durationMs),
            ...(wallet ? { wallet } : {}),
            slow_threshold_ms: envConfig.SLOW_REQUEST_THRESHOLD_MS,
         };
         logger.warn(payload, 'Slow request detected');
      }
   };

   res.once('finish', logOnce);
   res.once('close', logOnce);

   next();
};
