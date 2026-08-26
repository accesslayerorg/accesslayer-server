// src/middlewares/request-id.middleware.ts
import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { envConfig } from '../config';

function readHeader(req: Request, name: string): string | undefined {
   const raw = req.headers[name];
   if (Array.isArray(raw)) return raw[0]?.trim() || undefined;
   return typeof raw === 'string' ? raw.trim() || undefined : undefined;
}

/**
 * Returns true when the caller presents the shared internal service token,
 * meaning it is a trusted internal caller whose incoming `X-Trace-Id` should
 * be reused rather than overwritten with a freshly generated one.
 *
 * Untrusted (public-facing) callers cannot inject an arbitrary trace ID —
 * doing so would let a client pollute log correlation or forge a trace ID
 * that matches an unrelated request.
 */
function isTrustedInternalCaller(req: Request): boolean {
   const configuredToken = envConfig.TRACE_ID_TRUSTED_TOKEN;
   if (!configuredToken) return false;

   const presentedToken = readHeader(req, 'x-internal-service-token');
   return presentedToken === configuredToken;
}

/**
 * Middleware that assigns a unique trace ID to every incoming request.
 *
 * - A trusted internal caller (one presenting the configured
 *   `x-internal-service-token`) may supply its own `X-Trace-Id` header,
 *   which is reused as-is so a trace can be correlated across services.
 * - Otherwise an `X-Request-ID` header is honored for backwards-compatible
 *   client-side correlation, or a new UUID v4 is generated.
 *
 * The resulting ID is:
 * - Stored on `req.requestId` and `req.traceId` (same value) for use in
 *   controllers, services, and logging
 * - Returned in both the `X-Request-ID` and `X-Trace-Id` response headers
 */
export const requestIdMiddleware = (
   req: Request,
   res: Response,
   next: NextFunction
): void => {
   const incomingTraceId = readHeader(req, 'x-trace-id');
   const incomingRequestId = readHeader(req, 'x-request-id');

   const traceId =
      (incomingTraceId && isTrustedInternalCaller(req)
         ? incomingTraceId
         : undefined) ??
      incomingRequestId ??
      crypto.randomUUID();

   // Attach to the request object for downstream use
   req.requestId = traceId;
   req.traceId = traceId;

   // Echo in the response headers so clients and internal callers can correlate
   res.setHeader('X-Request-ID', traceId);
   res.setHeader('X-Trace-Id', traceId);

   next();
};

// Augment Express Request type to include requestId / traceId
declare global {
   namespace Express {
      interface Request {
         requestId?: string;
         traceId?: string;
      }
   }
}
