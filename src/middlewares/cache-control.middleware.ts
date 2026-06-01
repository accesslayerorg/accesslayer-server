// src/middlewares/cache-control.middleware.ts
import { Request, Response, NextFunction } from 'express';
import { PUBLIC_ENDPOINT_CACHE_PRESETS } from '../constants/public-endpoint-cache.constants';

/**
 * Cache control options for different types of endpoints.
 */
export interface CacheControlOptions {
   /**
    * Max age in seconds. Default: 300 (5 minutes)
    */
   maxAge?: number;
   /**
    * Whether the cache is public (CDN can cache) or private (browser only).
    * Default: 'public'
    */
   type?: 'public' | 'private';
   /**
    * Whether to include must-revalidate directive.
    * Default: false
    */
   mustRevalidate?: boolean;
   /**
    * Whether to include no-cache directive (requires revalidation).
    * Default: false
    */
   noCache?: boolean;
   /**
    * Whether to disable caching entirely.
    * Default: false
    */
   noStore?: boolean;
   /**
    * Max stale window in seconds. When set, allows serving stale content
    * if the origin is unreachable. Default: undefined (disabled)
    */
   staleIfError?: number;
}

/**
 * Middleware factory that adds Cache-Control headers to responses.
 *
 * Applies only to GET requests to avoid caching mutations.
 * Keeps cache behavior explicit and easy to understand in code.
 *
 * @param options - Cache control configuration
 *
 * @example
 * // Public endpoint with 5-minute cache
 * router.get('/creators', cacheControl({ maxAge: 300 }), listCreators);
 *
 * @example
 * // No caching for sensitive data
 * router.get('/profile', cacheControl({ noStore: true }), getProfile);
 */
export function cacheControl(options: CacheControlOptions = {}) {
   const {
      maxAge = 300,
      type = 'public',
      mustRevalidate = false,
      noCache = false,
      noStore = false,
      staleIfError,
   } = options;

   return (req: Request, res: Response, next: NextFunction): void => {
      // Only apply cache headers to GET requests
      // Mutation routes (POST, PUT, DELETE, PATCH) remain unaffected
      if (req.method !== 'GET') {
         return next();
      }

      // Build Cache-Control header value
      const directives: string[] = [];

      if (noStore) {
         directives.push('no-store');
      } else if (noCache) {
         directives.push('no-cache');
      } else {
         directives.push(type);
         directives.push(`max-age=${maxAge}`);
         if (mustRevalidate) {
            directives.push('must-revalidate');
         }
         if (staleIfError !== undefined) {
            directives.push(`stale-if-error=${staleIfError}`);
         }
      }

      res.setHeader('Cache-Control', directives.join(', '));
      next();
   };
}

/**
 * Preset cache configurations for common use cases.
 */
export const CachePresets = {
   /**
    * Short cache for frequently updated public data (5 minutes)
    */
   publicShort: PUBLIC_ENDPOINT_CACHE_PRESETS.short,

   /**
    * Medium cache for moderately stable public data (1 hour)
    */
   publicMedium: PUBLIC_ENDPOINT_CACHE_PRESETS.medium,

   /**
    * Long cache for stable public data (24 hours)
    */
   publicLong: PUBLIC_ENDPOINT_CACHE_PRESETS.long,

   /**
    * Private cache for user-specific data (5 minutes)
    */
   private: { maxAge: 300, type: 'private' as const },

   /**
    * No caching for sensitive or dynamic data
    */
   noCache: { noStore: true },
};
