import { Request, Response, NextFunction } from 'express';
import { envConfig } from '../config';
import { sendForbidden, sendUnauthorized } from '../utils/api-response.utils';

/**
 * Middleware restricting route access to internal service callers (such as indexers)
 * using an API key provided in the `x-api-key` header or `Authorization: Bearer <key>` header.
 */
export function requireInternalApiKey(
   req: Request,
   res: Response,
   next: NextFunction
): void {
   const apiKeyHeader =
      req.headers['x-api-key'] ||
      req.headers['X-API-KEY'] ||
      req.headers['x-indexer-api-key'];

   let providedKey: string | undefined;

   if (typeof apiKeyHeader === 'string' && apiKeyHeader.trim().length > 0) {
      providedKey = apiKeyHeader.trim();
   } else if (
      req.headers.authorization &&
      req.headers.authorization.startsWith('Bearer ')
   ) {
      providedKey = req.headers.authorization.substring(7).trim();
   }

   if (!providedKey) {
      sendUnauthorized(res, 'Internal API key is required');
      return;
   }

   const validKeys = [
      process.env.INDEXER_API_KEY,
      envConfig.INDEXER_API_KEY,
      process.env.INTERNAL_SERVICE_KEY,
      envConfig.INTERNAL_SERVICE_KEY,
      envConfig.APP_SECRET,
   ].filter((key): key is string => typeof key === 'string' && key.length > 0);

   if (!validKeys.includes(providedKey)) {
      sendForbidden(res, 'Invalid internal API key');
      return;
   }

   next();
}
