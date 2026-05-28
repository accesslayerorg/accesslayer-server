# Creator Request Lifecycle

This reference describes the request flow for the public creator routes mounted
under `/api/v1/creators`.

## Route registration

- `src/modules/creators/creators.routes.ts` registers the public creator list
  and stats routes.
- `src/modules/creator/creator.routes.ts` keeps the legacy scaffolded creator
  routes aligned with the same handler conventions.

## Request order

1. The request enters the creator router.
2. `normalizeTrailingSlash` removes an optional trailing slash so the same
   handler serves `/api/v1/creators` and `/api/v1/creators/`.
3. `createCreatorReadMetricsMiddleware(...)` starts request timing and records
   success/error counts when the response finishes.
4. `cacheControl(...)` applies the public cache headers for GET responses.
5. The controller builds a request context with the raw query object.
6. The controller logs unexpected sort fields at debug/warn level without
   mutating the request payload used for validation.
7. `parsePublicQuery(...)` validates and normalizes the query parameters.
8. `fetchCreatorList(...)` builds the Prisma filter and either serves a cached
   response or queries the database.
9. `serializeCreatorListResponse(...)` wraps the list and pagination metadata.
10.   `attachTimestampHeader(...)` adds the response timestamp header.
11.   `sendSuccess(...)` writes the JSON response body.

## Validation and logging points

- Validation happens inside the controller before the database query runs.
- Cache lookup and cache hit/miss ratio logging happen in the list service.
- Query normalization debug snapshots are emitted only when debug logging is
  enabled.
- The cache-key helper percent-encodes special characters before the key is
  logged or used for cache storage.
