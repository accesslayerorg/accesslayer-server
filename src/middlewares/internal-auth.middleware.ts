// src/middlewares/internal-auth.middleware.ts
import { Request, Response, NextFunction } from 'express';
import { envConfig } from '../config';
import { sendUnauthorized } from '../utils/api-response.utils';
import { extractBearerToken } from '../utils/jwt.utils';

/**
 * Middleware restricting access to internal service callers (such as indexers)
 * using API key authentication.
 *
 * Checks `x-api-key`, `x-internal-service-key`, or `Authorization: Bearer <key>`.
 */
export function requireInternalApiKey(
   req: Request,
   res: Response,
   next: NextFunction
): void {
   const configuredKey =
      envConfig.INTERNAL_SERVICE_KEY ||
      process.env.INDEXER_API_KEY ||
      process.env.INTERNAL_API_KEY;

   const providedHeader =
      req.headers['x-api-key'] ||
      req.headers['x-internal-service-key'];

   const providedKey =
      (Array.isArray(providedHeader) ? providedHeader[0] : providedHeader) ||
      extractBearerToken(req.headers.authorization);

   if (!providedKey) {
      sendUnauthorized(
         res,
         'Authentication required. Send an x-api-key or x-internal-service-key header.'
      );
      return;
   }

   if (configuredKey && providedKey !== configuredKey) {
      sendUnauthorized(res, 'Invalid internal API key');
      return;
   }

   next();
}
