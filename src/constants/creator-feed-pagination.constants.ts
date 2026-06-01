// src/constants/creator-feed-pagination.constants.ts
// Dedicated pagination constants for creator feed endpoints.
// Keeps feed-specific defaults separate from the generic pagination policy
// so they can evolve independently without touching shared constants.

/**
 * Default number of items returned per page on creator feed endpoints.
 * Feed pages are intentionally smaller than generic list pages to reduce
 * payload size on high-frequency polling calls.
 */
export const CREATOR_FEED_DEFAULT_PAGE_SIZE = 20;

/**
 * Maximum page size accepted by creator feed endpoints.
 * Matches the shared MAX_PAGE_SIZE but is declared here so feed handlers
 * don't have an implicit dependency on the generic pagination module.
 */
export const CREATOR_FEED_MAX_PAGE_SIZE = 100;

/**
 * Minimum page size accepted by creator feed endpoints.
 */
export const CREATOR_FEED_MIN_PAGE_SIZE = 1;
