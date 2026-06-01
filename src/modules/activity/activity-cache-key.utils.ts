/**
 * Cache key builder for creator activity feed responses.
 *
 * This utility generates deterministic cache keys that include all
 * filter and pagination inputs to ensure cache invalidation works correctly.
 */
import { ActivityQueryType } from './activity.schemas';

/**
 * Builds a cache key for the activity feed endpoint.
 *
 * The key includes all query parameters to ensure that different
 * filter/pagination combinations have separate cache entries.
 *
 * @param query - The parsed activity feed query parameters
 * @returns A deterministic cache key string
 *
 * @example
 * ```ts
 * const key = buildActivityFeedCacheKey({
 *   limit: 10,
 *   offset: 0,
 *   creatorId: 'abc123',
 *   actor: 'xyz789',
 *   type: 'KEY_BOUGHT'
 * });
 * // Returns: "activity:limit:10:offset:0:creatorId:abc123:actor:xyz789:type:KEY_BOUGHT"
 * ```
 */
export function buildActivityFeedCacheKey(query: ActivityQueryType): string {
    const parts: string[] = ['activity'];

    // Add pagination parameters
    parts.push(`limit:${query.limit}`);
    parts.push(`offset:${query.offset}`);

    // Add filter parameters if present
    if (query.creatorId) {
        parts.push(`creatorId:${query.creatorId}`);
    }

    if (query.actor) {
        parts.push(`actor:${query.actor}`);
    }

    if (query.type) {
        parts.push(`type:${query.type}`);
    }

    return parts.join(':');
}

/**
 * Cache invalidation touchpoints for the activity feed.
 *
 * The activity feed cache should be invalidated when:
 * - A creator is registered (CREATOR_REGISTERED event)
 * - A key is bought (KEY_BOUGHT event)
 * - A key is sold (KEY_SOLD event)
 * - A profile is updated (PROFILE_UPDATED event)
 *
 * These events are the same as the activity feed types, so any new activity
 * that would appear in the feed should invalidate the cache.
 *
 * Implementation note: Cache invalidation should be triggered in the
 * respective event handlers or service methods that create these activities.
 * Use the cache key builder to determine which keys to invalidate based on
 * the affected creator or actor.
 */
export const ACTIVITY_FEED_CACHE_INVALIDATION_TOUCHPOINTS = {
    CREATOR_REGISTERED: 'creator:registered',
    KEY_BOUGHT: 'key:bought',
    KEY_SOLD: 'key:sold',
    PROFILE_UPDATED: 'profile:updated',
} as const;

/**
 * Builds cache keys for invalidation based on a creator ID.
 *
 * When an activity event occurs for a specific creator, this helper
 * generates all cache key patterns that should be invalidated for that creator.
 *
 * @param creatorId - The creator ID whose cache should be invalidated
 * @returns Array of cache key patterns to invalidate
 *
 * @example
 * ```ts
 * const keys = buildActivityFeedInvalidationKeys('abc123');
 * // Returns: ['activity:*:creatorId:abc123:*']
 * ```
 */
export function buildActivityFeedInvalidationKeys(creatorId: string): string[] {
    // Invalidate all activity feed entries for this creator
    // regardless of pagination or other filters
    return [`activity:*:creatorId:${creatorId}:*`];
}
