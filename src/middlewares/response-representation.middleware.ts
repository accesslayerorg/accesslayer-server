// src/middlewares/response-representation.middleware.ts
// Transfer-size and cache-policy handling for API responses (#1343).
//
// Both middlewares wrap res.send, which res.json also goes through. They do
// not stream, so response types written with res.write/res.pipe are left
// alone.
//
// Conditional requests need no code here: Express already emits a weak ETag
// for every res.send body and answers If-None-Match with 304 and no body.
// That ETag is computed over the bytes actually sent, so a gzip body and an
// identity body get distinct ETags.

import zlib from 'zlib';
import { NextFunction, Request, Response } from 'express';

/** Bodies smaller than this are not worth compressing. */
export const COMPRESSION_MIN_BYTES = 1024;

const COMPRESSIBLE_APPLICATION_TYPES = new Set([
   'application/json',
   'application/javascript',
   'application/xml',
   'application/graphql-response+json',
]);

export type ContentEncoding = 'br' | 'gzip';

/** Whether a Content-Type value is worth compressing. */
export function isCompressibleContentType(contentType: string | undefined): boolean {
   if (!contentType) return false;
   const type = contentType.split(';')[0].trim().toLowerCase();
   return (
      type.startsWith('text/') ||
      COMPRESSIBLE_APPLICATION_TYPES.has(type) ||
      type.endsWith('+json') ||
      type.endsWith('+xml') ||
      type === 'image/svg+xml'
   );
}

/**
 * Choose a content coding from Accept-Encoding. Brotli is preferred when the
 * client weights it at least as high as gzip. Returns null when neither is
 * acceptable (q=0 or absent).
 */
export function negotiateEncoding(acceptEncoding: string | undefined): ContentEncoding | null {
   if (!acceptEncoding) return null;

   const weights = new Map<string, number>();
   for (const part of acceptEncoding.split(',')) {
      const [rawName, ...params] = part.trim().toLowerCase().split(';');
      let weight = 1;
      for (const param of params) {
         const match = /^\s*q\s*=\s*([\d.]+)\s*$/.exec(param);
         if (match) weight = Number(match[1]);
      }
      if (rawName) weights.set(rawName.trim(), Number.isFinite(weight) ? weight : 0);
   }

   const wildcard = weights.get('*') ?? 0;
   const brWeight = weights.get('br') ?? wildcard;
   const gzipWeight = weights.get('gzip') ?? wildcard;

   if (brWeight > 0 && brWeight >= gzipWeight) return 'br';
   if (gzipWeight > 0) return 'gzip';
   return null;
}

export function encodeBody(body: Buffer, encoding: ContentEncoding): Buffer {
   if (encoding === 'br') {
      return zlib.brotliCompressSync(body, {
         params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 },
      });
   }
   return zlib.gzipSync(body);
}

/** Path with the /api and /v<n> prefixes removed, e.g. /api/v1/admin -> /admin. */
function routePath(req: Request): string {
   return req.path.replace(/^\/(?:api\/)?v\d+(?=\/|$)/, '') || '/';
}

/** True when the request carries credentials that make the response user-specific. */
function isAuthenticatedRequest(req: Request): boolean {
   return Boolean(req.headers.authorization || req.headers.cookie);
}

function isAdminRoute(req: Request): boolean {
   const path = routePath(req);
   return path === '/admin' || path.startsWith('/admin/');
}

type SendFn = (this: Response, body?: unknown) => Response;

/**
 * Compress string and Buffer bodies with br or gzip when the client accepts
 * it, the body is at least COMPRESSION_MIN_BYTES, and the content type is
 * compressible. Adds Vary: Accept-Encoding to every such response so shared
 * caches never serve one encoding to a client that asked for another.
 */
export function responseCompressionMiddleware(
   req: Request,
   res: Response,
   next: NextFunction
): void {
   const encoding = negotiateEncoding(req.headers['accept-encoding']);
   const originalSend = res.send as unknown as SendFn;

   const patchedSend: SendFn = function patchedSend(this: Response, body?: unknown) {
      const hasBody =
         res.statusCode !== 204 &&
         res.statusCode !== 304 &&
         (typeof body === 'string' || Buffer.isBuffer(body));

      const contentType = res.getHeader('Content-Type');
      const effectiveType =
         typeof contentType === 'string'
            ? contentType
            : typeof body === 'string'
              ? 'text/html'
              : undefined;
      const compressibleBody = hasBody && isCompressibleContentType(effectiveType);

      // Vary on every compressible response, even when this request asked for
      // no encoding, so a shared cache never stores one representation under
      // the key of another.
      if (compressibleBody) {
         res.vary('Accept-Encoding');
      }

      const isCandidate =
         compressibleBody &&
         req.method !== 'HEAD' &&
         !res.getHeader('Content-Encoding');

      if (!isCandidate || encoding === null) {
         return originalSend.call(this, body);
      }

      const raw = Buffer.isBuffer(body) ? body : Buffer.from(body as string, 'utf8');
      if (raw.length < COMPRESSION_MIN_BYTES) {
         return originalSend.call(this, body);
      }

      let compressed: Buffer;
      try {
         compressed = encodeBody(raw, encoding);
      } catch {
         return originalSend.call(this, body);
      }
      if (compressed.length >= raw.length) {
         return originalSend.call(this, body);
      }

      res.setHeader('Content-Encoding', encoding);
      return originalSend.call(this, compressed);
   };

   res.send = patchedSend as unknown as typeof res.send;
   next();
}

/**
 * Apply Cache-Control defaults by route group and keep user data out of
 * shared caches.
 *
 * - /admin/*: no-store. Admin data is never cached.
 * - Authenticated requests: default private, no-cache. A route that sets
 *   Cache-Control: public is rewritten to private at send time, and the
 *   response varies on Authorization.
 * - Anonymous requests: left to each route's cacheControl() preset.
 */
export function responseCachePolicyMiddleware(
   req: Request,
   res: Response,
   next: NextFunction
): void {
   const adminRoute = isAdminRoute(req);
   const authenticated = isAuthenticatedRequest(req);

   if (adminRoute) {
      res.setHeader('Cache-Control', 'no-store');
   } else if (authenticated) {
      res.setHeader('Cache-Control', 'private, no-cache');
   }

   const originalSend = res.send as unknown as SendFn;
   const patchedSend: SendFn = function patchedSend(this: Response, body?: unknown) {
      if (adminRoute) {
         this.setHeader('Cache-Control', 'no-store');
      } else if (authenticated) {
         const current = this.getHeader('Cache-Control');
         if (typeof current === 'string' && /(^|,\s*)public\b/i.test(current)) {
            this.setHeader(
               'Cache-Control',
               current.replace(/(^|,\s*)public\b/gi, '$1private')
            );
         }
         this.vary('Authorization');
      }
      return originalSend.call(this, body);
   };

   res.send = patchedSend as unknown as typeof res.send;
   next();
}
