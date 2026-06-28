// src/middlewares/trailing-slash-normalizer.middleware.ts
import { RequestHandler } from 'express';

/**
 * Middleware that normalizes trailing slashes by stripping them from the
 * request URL (except for the bare root path '/').
 *
 * Mutates `req.url` in-place so Express re-matches the modified path against
 * the remaining route handlers in the same router chain — no redirect is
 * issued, so clients never observe an extra round-trip.
 *
 * Query strings are preserved: `/path/?q=1` becomes `/path?q=1`.
 *
 * Apply this middleware to a specific router (e.g. `creatorsRouter`) to avoid
 * unintended side-effects on unrelated route groups.
 *
 * @example
 * creatorsRouter.use(normalizeTrailingSlash);
 */
export const normalizeTrailingSlash: RequestHandler = (req, _res, next) => {
   const url = req.url;

   // Split path and query string so we only test the path portion.
   const qIdx = url.indexOf('?');
   const pathname = qIdx === -1 ? url : url.slice(0, qIdx);
   const search = qIdx === -1 ? '' : url.slice(qIdx);

   // Only strip when the path has a trailing slash AND is not the root '/'.
   if (pathname !== '/' && pathname.endsWith('/')) {
      req.url = pathname.slice(0, -1) + search;
   }

   next();
};
