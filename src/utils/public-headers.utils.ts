import { Request, Response, NextFunction } from 'express';
import { cacheControl, CachePresets } from '../middlewares/cache-control.middleware';

/**
 * Sets common headers for public, read-only endpoints.
 * Applies a short public cache and marks the response as non-credentialed.
 */
export function setPublicHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  cacheControl(CachePresets.publicShort)(req, res, next);
}
