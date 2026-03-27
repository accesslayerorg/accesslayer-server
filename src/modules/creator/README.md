# Creator Module

Initial scaffold for creator-facing API surfaces.

## Route structure

All routes are mounted under `/api/v1/creators`.

- `GET /` — existing paginated creator list.
- `GET /:creatorId/profile` — placeholder creator profile read endpoint.
- `PUT /:creatorId/profile` — placeholder creator profile write endpoint.

## Handler surface (scaffold)

### Read profile (`GET /:creatorId/profile`)

- Validates `creatorId` path parameter.
- Returns explicit placeholder response shape:
   - `creatorId`
   - `displayName`
   - `bio`
   - `avatarUrl`
   - `links[]`
   - `metadata.source` and `metadata.isProfileComplete`

### Write profile (`PUT /:creatorId/profile`)

- Validates `creatorId` path parameter.
- Validates payload fields:
   - `displayName`
   - `bio`
   - `avatarUrl`
   - `links[]` (`label`, `url`)
- Returns `202 Accepted` with validated payload echo + placeholder metadata.

## Notes for follow-up issues

- Authentication and authorization are intentionally deferred.
- Persistence/indexing integration is intentionally deferred.
- Current handlers are designed so storage/indexing can be added without changing route contracts.
