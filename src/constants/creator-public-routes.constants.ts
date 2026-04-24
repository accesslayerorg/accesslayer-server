/**
 * Shared route name constants for creator-facing public API endpoints.
 *
 * These constants provide stable identifiers for public creator routes,
 * allowing related modules (controllers, tests, client-side) to reference
 * routes by name instead of hardcoded strings.
 */
export const CREATOR_PUBLIC_ROUTE_NAMES = {
   /** GET /api/v1/creators - Paginated list of creators */
   LIST: 'creators:list',
   /** GET /api/v1/creators/:creatorId/profile - Public profile details */
   GET_PROFILE: 'creators:profile:get',
   /** PUT /api/v1/creators/:creatorId/profile - Upsert profile (scaffold) */
   UPSERT_PROFILE: 'creators:profile:upsert',
   /** GET /api/v1/creators/:creatorId/stats - Public creator stats */
   GET_STATS: 'creators:stats:get',
} as const;
