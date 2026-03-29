/**
 * Cache settings for creator-facing public routes (CDN/browser caching).
 *
 * Reuses shared TTLs from {@link PUBLIC_ENDPOINT_CACHE_SECONDS} where appropriate.
 */
import { PUBLIC_ENDPOINT_CACHE_SECONDS } from './public-endpoint-cache.constants';

/**
 * Max-age (seconds) for public creator GET responses (list, profile, stats).
 */
export const CREATOR_PUBLIC_ROUTE_CACHE_MAX_AGE_SECONDS = {
   publicRead: PUBLIC_ENDPOINT_CACHE_SECONDS.short,
} as const;

const publicReadSeconds = CREATOR_PUBLIC_ROUTE_CACHE_MAX_AGE_SECONDS.publicRead;

/**
 * Options for {@link cacheControl} on creator public routes.
 */
export const CREATOR_PUBLIC_ROUTE_CACHE_PRESETS = {
   creatorList: {
      maxAge: publicReadSeconds,
      type: 'public' as const,
   },
   creatorStats: {
      maxAge: publicReadSeconds,
      type: 'public' as const,
   },
   creatorProfile: {
      maxAge: publicReadSeconds,
      type: 'public' as const,
   },
} as const;

/**
 * Full `Cache-Control` header values for creator public routes
 * (e.g. `res.setHeader('Cache-Control', ...)` or tests).
 */
export const CREATOR_PUBLIC_ROUTE_CACHE_CONTROL_HEADER = {
   publicRead: `public, max-age=${publicReadSeconds}`,
} as const;
