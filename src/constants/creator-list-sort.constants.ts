/**
 * Allowed public sort fields for creator list endpoints.
 * Keep these names stable for request parsing across list handlers.
 */
export const CREATOR_LIST_SORT_FIELDS = [
   'createdAt',
   'updatedAt',
   'displayName',
   'handle',
] as const;

export type CreatorListSortField = (typeof CREATOR_LIST_SORT_FIELDS)[number];

/**
 * Allowed sort orders for creator list endpoints.
 */
export const CREATOR_LIST_SORT_ORDERS = ['asc', 'desc'] as const;

export type CreatorListSortOrder = (typeof CREATOR_LIST_SORT_ORDERS)[number];

/** Default sort field used by creator list handlers. */
export const DEFAULT_CREATOR_LIST_SORT: CreatorListSortField = 'createdAt';

/** Default sort order used by creator list handlers. */
export const DEFAULT_CREATOR_LIST_ORDER: CreatorListSortOrder = 'desc';
