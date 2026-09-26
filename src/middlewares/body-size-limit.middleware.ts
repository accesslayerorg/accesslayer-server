import express, { RequestHandler } from 'express';
import { envConfig } from '../config';

/**
 * Route groups that can be given their own request body size limit.
 * Add a group here (and its optional `BODY_SIZE_LIMIT_<GROUP>` override in
 * config.schema.ts) when a mount point in modules/index.ts needs a distinct
 * limit from BODY_SIZE_LIMIT_DEFAULT.
 */
export type BodySizeLimitGroup = 'auth' | 'admin' | 'creators' | 'default';

const GROUP_OVERRIDES: Record<
   Exclude<BodySizeLimitGroup, 'default'>,
   string | undefined
> = {
   auth: envConfig.BODY_SIZE_LIMIT_AUTH,
   admin: envConfig.BODY_SIZE_LIMIT_ADMIN,
   creators: envConfig.BODY_SIZE_LIMIT_CREATORS,
};

/**
 * Resolves the configured body size limit for a route group, falling back
 * to BODY_SIZE_LIMIT_DEFAULT when the group has no override configured.
 */
export function getBodySizeLimit(group: BodySizeLimitGroup): string {
   if (group === 'default') {
      return envConfig.BODY_SIZE_LIMIT_DEFAULT;
   }

   return GROUP_OVERRIDES[group] ?? envConfig.BODY_SIZE_LIMIT_DEFAULT;
}

/**
 * Returns a JSON body parser scoped to the given route group's configured
 * size limit. Mount this in place of a global `express.json()` at the top
 * of each route group in modules/index.ts.
 *
 * A request exceeding the limit is not rejected here directly — express.json
 * hands control to `next(err)` with a body-parser `entity.too.large` error,
 * which bodyParseErrorMiddleware (mounted after all route groups in app.ts)
 * turns into the actual 413 response. This keeps the "fail fast with a
 * clear error" behavior identical across every group regardless of its
 * configured limit.
 */
export function routeBodySizeLimit(group: BodySizeLimitGroup): RequestHandler {
   return express.json({ limit: getBodySizeLimit(group) });
}
