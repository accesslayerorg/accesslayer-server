// src/middlewares/request-id.middleware.ts
import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

/**
 * Middleware that assigns a unique request ID to every incoming request.
 *
 * If the client sends an `X-Request-ID` header the value is forwarded
 * (useful for distributed tracing). Otherwise a new UUID v4 is generated.
 *
 * The ID is:
 * - Stored on `req.requestId` for use in controllers and logging
 * - Returned in the `X-Request-ID` response header for client correlation
 */
export const requestIdMiddleware = (
   req: Request,
   res: Response,
   next: NextFunction
): void => {
   const requestId =
      (req.headers['x-request-id'] as string) || crypto.randomUUID();

   // Attach to the request object for downstream use
   (req as any).requestId = requestId;

   // Echo in the response header so clients can correlate
   res.setHeader('X-Request-ID', requestId);

   next();
};

// Augment Express Request type to include requestId
declare global {
   namespace Express {
      interface Request {
         requestId?: string;
      }
   }
}
