// src/modules/creator/creator-analytics.constants.ts
// Tunables for the creator key analytics endpoint.

/** Number of daily buckets returned (inclusive of today). */
export const ANALYTICS_WINDOW_DAYS = 30;

/** Redis TTL for the full analytics response (10 minutes). */
export const ANALYTICS_CACHE_TTL_SECONDS = 600;

const ANALYTICS_CACHE_KEY_PREFIX = 'creator:analytics';

/** Deterministic Redis cache key for a key's analytics payload. */
export function buildCreatorAnalyticsCacheKey(keyId: string): string {
   return `${ANALYTICS_CACHE_KEY_PREFIX}:${keyId}`;
}
