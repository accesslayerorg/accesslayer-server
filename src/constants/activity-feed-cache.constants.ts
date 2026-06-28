/**
 * Cache settings for the activity feed endpoint.
 *
 * These constants define cache behavior for the public activity feed
 * endpoint, which lists activities with optional filtering and pagination.
 */
import { PUBLIC_ENDPOINT_CACHE_SECONDS } from './public-endpoint-cache.constants';

/**
 * Max-age (seconds) for activity feed responses.
 *
 * Activity feeds are frequently updated but can be cached for short periods
 * to reduce database load. A 2-minute cache provides a balance between
 * freshness and performance.
 */
export const ACTIVITY_FEED_CACHE_MAX_AGE_SECONDS = PUBLIC_ENDPOINT_CACHE_SECONDS.short;

/**
 * Cache control preset for the activity feed endpoint.
 */
export const ACTIVITY_FEED_CACHE_PRESET = {
    maxAge: ACTIVITY_FEED_CACHE_MAX_AGE_SECONDS,
    type: 'public' as const,
    staleIfError: 86400, // 24 hours
} as const;

/**
 * Full `Cache-Control` header value for the activity feed endpoint.
 */
export const ACTIVITY_FEED_CACHE_CONTROL_HEADER = `public, max-age=${ACTIVITY_FEED_CACHE_MAX_AGE_SECONDS}, stale-if-error=86400`;
