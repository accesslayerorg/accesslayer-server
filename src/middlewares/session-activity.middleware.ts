// src/middlewares/session-activity.middleware.ts
// Records one session-activity row per authenticated request and runs
// anomaly detection against it (#1035).
//
// Auth guards (requireJwtAuth et al.) attach `req.user` per-route, so this
// middleware cannot inspect the wallet during the pre-handler phase. Instead
// it registers a `res.on('finish')` listener: by the time the response
// finishes, any route-level auth middleware has already run, so `req.user`
// reflects whether the request was authenticated. Unauthenticated requests
// are skipped.

import { Request, Response, NextFunction } from 'express';
import { recordSessionActivity } from '../modules/admin/session-security.service';
import { logger } from '../utils/logger.utils';

interface SessionActivityRequest extends Request {
   user?: {
      wallet: string;
      userId?: string;
   };
}

/** Path prefix that should never be activity-logged (noise reduction). */
const EXACT_PATHS = new Set(['/api/v1/health', '/status']);

export function sessionActivityMiddleware(
   req: SessionActivityRequest,
   res: Response,
   next: NextFunction
): void {
   res.on('finish', () => {
      const wallet = req.user?.wallet;
      if (!wallet) {
         return;
      }

      const path = (req.originalUrl || req.url || '').split('?')[0];
      if (EXACT_PATHS.has(path)) {
         return;
      }

      // Fire-and-forget: logging/anomaly detection must never delay or
      // fail the response. recordSessionActivity already swallows its own
      // errors; this catch is a belt-and-braces guard.
      void recordSessionActivity({
         wallet,
         ip: req.ip ?? req.socket?.remoteAddress ?? 'unknown',
         userAgent: req.headers['user-agent'] ?? null,
         method: req.method,
         endpoint: path,
         statusCode: res.statusCode,
      }).catch(error => {
         logger.error(
            { type: 'session_activity_middleware_error', error },
            'Unexpected session activity logging failure'
         );
      });
   });

   next();
}
