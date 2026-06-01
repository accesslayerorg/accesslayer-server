// src/middlewares/deprecation.middleware.ts
import { Request, Response, NextFunction } from 'express';

/**
 * Metadata describing a deprecated endpoint.
 */
export interface DeprecationOptions {
   /**
    * ISO 8601 date string indicating when the endpoint was deprecated.
    * Emitted as the `Deprecation` header per draft-ietf-httpapi-deprecation-header.
    *
    * @example '2026-01-01T00:00:00Z'
    */
   deprecatedSince: string;

   /**
    * ISO 8601 date string for when the endpoint will be removed.
    * Emitted as the `Sunset` header per RFC 8594.
    *
    * @example '2026-07-01T00:00:00Z'
    */
   sunsetDate?: string;

   /**
    * URL pointing to migration docs or the replacement endpoint.
    * Emitted as a `Link` header with rel="successor-version".
    *
    * @example 'https://docs.example.com/migration/v2'
    */
   link?: string;
}

/**
 * Middleware factory that marks an endpoint as deprecated by injecting
 * standard response headers.
 *
 * Headers set:
 * - `Deprecation`  – date the endpoint was deprecated (RFC / IETF draft)
 * - `Sunset`       – planned removal date (RFC 8594), when provided
 * - `Link`         – migration URL with rel="successor-version", when provided
 *
 * @example
 * router.get(
 *   '/v1/creators',
 *   deprecate({
 *     deprecatedSince: '2026-01-01T00:00:00Z',
 *     sunsetDate: '2026-07-01T00:00:00Z',
 *     link: '/api/v2/creators',
 *   }),
 *   listCreators,
 * );
 */
export function deprecate(options: DeprecationOptions) {
   const { deprecatedSince, sunsetDate, link } = options;

   return (_req: Request, res: Response, next: NextFunction): void => {
      res.setHeader('Deprecation', deprecatedSince);

      if (sunsetDate) {
         res.setHeader('Sunset', sunsetDate);
      }

      if (link) {
         res.setHeader('Link', `<${link}>; rel="successor-version"`);
      }

      next();
   };
}
