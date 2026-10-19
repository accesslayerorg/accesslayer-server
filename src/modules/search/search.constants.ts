// src/modules/search/search.constants.ts

/** How many results each category contributes to the grouped overlay response. */
export const SEARCH_GROUP_LIMITS = {
   keys: 3,
   creators: 3,
   transactions: 1,
} as const;

/** Minimum trimmed query length accepted by every search endpoint. */
export const SEARCH_MIN_QUERY_LENGTH = 2;

/** Upper bound on the query string, to keep ILIKE patterns bounded. */
export const SEARCH_MAX_QUERY_LENGTH = 100;

/** Default page size for the full results endpoints. */
export const SEARCH_DEFAULT_LIMIT = 20;

/** Maximum page size for the full results endpoints. */
export const SEARCH_MAX_LIMIT = 100;
