/**
 * Cache key builder for creator feed responses.
 *
 * This utility generates deterministic cache keys that include all
 * filter and pagination inputs to ensure cache invalidation works correctly.
 */
import { CreatorListQueryType } from './creators.schemas';

/**
 * Builds a cache key for the creator feed endpoint.
 *
 * The key includes all query parameters to ensure that different
 * filter/pagination combinations have separate cache entries.
 *
 * @param query - The parsed creator feed query parameters
 * @returns A deterministic cache key string
 *
 * @example
 * ```ts
 * const key = buildCreatorFeedCacheKey({
 *   limit: 20,
 *   offset: 0,
 *   sort: 'createdAt',
 *   order: 'desc',
 *   verified: true,
 *   search: 'example',
 *   include: ['stats']
 * });
 * // Returns: "creators:limit:20:offset:0:sort:createdAt:order:desc:verified:true:search:example:include:stats"
 * ```
 */
export function buildCreatorFeedCacheKey(query: CreatorListQueryType): string {
    const parts: string[] = ['creators'];

    // Add pagination parameters
    parts.push(`limit:${query.limit}`);
    parts.push(`offset:${query.offset}`);

    // Add sorting parameters
    parts.push(`sort:${query.sort}`);
    parts.push(`order:${query.order}`);

    // Add filter parameters if present
    if (query.verified !== undefined) {
        parts.push(`verified:${query.verified}`);
    }

    if (query.search !== undefined && query.search !== '') {
        parts.push(`search:${query.search}`);
    }

    if (query.include !== undefined && query.include.length > 0) {
        parts.push(`include:${query.include.join(',')}`);
    }

    return parts.join(':');
}

/**
 * Cache invalidation touchpoints for the creator feed.
 *
 * The creator feed cache should be invalidated when:
 * - A creator is registered (new creator added to the feed)
 * - A creator profile is updated (display name, bio, avatar, etc.)
 * - A creator's verification status changes
 * - A creator's keys supply or floor price changes
 * - A creator's stats change
 *
 * These events affect the creator feed display and should trigger
 * cache invalidation for the affected creator or the entire feed.
 *
 * Implementation note: Cache invalidation should be triggered in the
 * respective service methods that create/update creators. Use the cache
 * key builder to determine which keys to invalidate based on the affected
 * creator or filter combinations.
 */
export const CREATOR_FEED_CACHE_INVALIDATION_TOUCHPOINTS = {
    CREATOR_REGISTERED: 'creator:registered',
    CREATOR_PROFILE_UPDATED: 'creator:profile:updated',
    CREATOR_VERIFICATION_CHANGED: 'creator:verification:changed',
    CREATOR_KEYS_UPDATED: 'creator:keys:updated',
    CREATOR_STATS_UPDATED: 'creator:stats:updated',
} as const;

/**
 * Builds cache keys for invalidation based on a creator ID.
 *
 * When a creator event occurs (profile update, verification change, etc.),
 * this helper generates all cache key patterns that should be invalidated
 * for that creator.
 *
 * @param creatorId - The creator ID whose cache should be invalidated
 * @returns Array of cache key patterns to invalidate
 *
 * @example
 * ```ts
 * const keys = buildCreatorFeedInvalidationKeys('abc123');
 * // Returns: ['creators:*:*:*:*:*:*:*'] (all creator feed entries)
 * ```
 */
export function buildCreatorFeedInvalidationKeys(_creatorId?: string): string[] {
    // Since the creator feed includes all creators and supports various filters,
    // we invalidate all creator feed entries when any creator changes.
    // This is a conservative approach that ensures cache consistency.
    return ['creators:*'];
}

/**
 * Builds cache keys for invalidation based on specific filter combinations.
 *
 * When a specific filter-relevant change occurs (e.g., verification status change),
 * this helper generates cache key patterns for affected filter combinations.
 *
 * @param filters - Object containing filter values that changed
 * @returns Array of cache key patterns to invalidate
 *
 * @example
 * ```ts
 * const keys = buildCreatorFeedFilterInvalidationKeys({ verified: true });
 * // Returns: ['creators:*:*:*:*:verified:true:*']
 * ```
 */
export function buildCreatorFeedFilterInvalidationKeys(filters: {
    verified?: boolean;
    search?: string;
}): string[] {
    const patterns: string[] = [];

    if (filters.verified !== undefined) {
        patterns.push(`creators:*:*:*:*:verified:${filters.verified}:*`);
    }

    if (filters.search !== undefined) {
        patterns.push(`creators:*:*:*:*:search:${filters.search}:*`);
    }

    // If no specific filters, invalidate all
    if (patterns.length === 0) {
        return ['creators:*'];
    }

    return patterns;
}
