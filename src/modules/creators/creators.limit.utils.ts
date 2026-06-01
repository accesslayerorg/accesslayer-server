import { CREATOR_FEED_DEFAULT_PAGE_SIZE, CREATOR_FEED_MAX_PAGE_SIZE, CREATOR_FEED_MIN_PAGE_SIZE } from '../../constants/creator-feed-pagination.constants';

/**
 * Resolve list limit for public creator list endpoints.
 *
 * Returns the feed-specific default page size when the incoming page size is
 * omitted, and clamps the value to the allowed [min, max] range.
 */
export function resolveCreatorListLimit(pageSize?: number): number {
  if (pageSize === undefined) return CREATOR_FEED_DEFAULT_PAGE_SIZE;
  return Math.min(
    CREATOR_FEED_MAX_PAGE_SIZE,
    Math.max(CREATOR_FEED_MIN_PAGE_SIZE, pageSize),
  );
}
