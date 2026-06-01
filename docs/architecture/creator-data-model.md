# Creator Data Model Reference

This document is the canonical field-level reference for the creator data model.
It consolidates definitions spread across the Prisma schema, TypeScript types,
Zod validation schemas, and API response shapes.

For module boundaries and high-level architecture, see
[Backend Domain Model and Endpoint Boundaries](./domain-boundaries.md).

## Source files

| Layer               | Path                                                 |
| :------------------ | :--------------------------------------------------- |
| Database            | `prisma/schema/creator.prisma`                       |
| TypeScript types    | `src/types/profile.types.ts`                         |
| Profile API schemas | `src/modules/creator/creator-profile.schemas.ts`     |
| List/update schemas | `src/modules/creators/creators.schemas.ts`           |
| Admin metadata      | `src/modules/admin/admin.controllers.ts`             |
| List projection     | `src/constants/creator-list-projection.constants.ts` |
| Detail projection   | `src/constants/creator-detail-include.constants.ts`  |
| Serializers         | `src/modules/creators/creators.serializers.ts`       |

---

## Persisted fields (`CreatorProfile`)

These fields are stored in the `CreatorProfile` Prisma model.

| Field         | Type       | Required | Constraints                                    | Purpose                                                      |
| :------------ | :--------- | :------- | :--------------------------------------------- | :----------------------------------------------------------- |
| `id`          | `string`   | yes      | Primary key; `@default(cuid())`                | Stable internal identifier for the creator profile           |
| `userId`      | `string`   | yes      | `@unique`; FK → `User.id`; `onDelete: Cascade` | Links the profile to exactly one user account                |
| `handle`      | `string`   | yes      | `@unique`; no format validation in Prisma      | Public slug used in URLs and lookups                         |
| `displayName` | `string`   | yes      | No length constraint in Prisma                 | Human-readable name shown in list and detail views           |
| `bio`         | `string`   | optional | Nullable                                       | Short creator biography                                      |
| `avatarUrl`   | `string`   | optional | Nullable; no format constraint in Prisma       | URL to the creator's avatar image                            |
| `perkSummary` | `string`   | optional | Nullable                                       | Short summary of creator perks (legacy field)                |
| `isVerified`  | `boolean`  | yes      | `@default(false)`                              | Verification badge; updated via admin tools                  |
| `perks`       | `Json`     | optional | Nullable; unstructured JSON in DB              | Structured perk list; validated as an array at the API layer |
| `createdAt`   | `DateTime` | yes      | `@default(now())`                              | Record creation timestamp                                    |
| `updatedAt`   | `DateTime` | yes      | `@updatedAt`                                   | Last modification timestamp                                  |

**Relationship:** Each `User` may have at most one `CreatorProfile` (`User.creatorProfile`).

---

## Nested type: `CreatorPerk`

Validated by `CreatorPerkSchema` in both profile and list schema modules.

| Field         | Type     | Required | Constraints               | Purpose                         |
| :------------ | :------- | :------- | :------------------------ | :------------------------------ |
| `id`          | `string` | optional | CUID or UUID when present | Stable perk identifier          |
| `title`       | `string` | yes      | 1–100 characters          | Perk headline                   |
| `description` | `string` | yes      | 1–500 characters          | Perk detail text                |
| `icon`        | `string` | optional | —                         | Optional icon identifier or URL |

---

## API-only fields (not yet persisted)

These fields appear in API contracts but are **not** stored in the Prisma model today.

| Field           | Type               | Required                                       | Constraints                                                                          | Purpose                                            |
| :-------------- | :----------------- | :--------------------------------------------- | :----------------------------------------------------------------------------------- | :------------------------------------------------- |
| `links`         | `{ label, url }[]` | optional (write); required (read, may be `[]`) | Max 8 links; label 1–40 chars; URL must be valid; URLs normalized before storage     | Social and external profile links                  |
| `links[].label` | `string`           | yes (when link present)                        | Trimmed; 1–40 characters                                                             | Platform or link name (e.g. `"twitter"`, `"site"`) |
| `links[].url`   | `string`           | yes (when link present)                        | Valid URL; trailing slashes removed; host lowercased; tracking query params stripped | Canonical social profile URL                       |

---

## Write schemas

### `UpsertCreatorProfileBodySchema` — `PUT /api/v1/creators/:creatorId/profile`

Used by the profile upsert handler. All top-level fields are optional; at least
one field is typically supplied per request.

| Field         | Type               | Required | Constraints                             |
| :------------ | :----------------- | :------- | :-------------------------------------- |
| `displayName` | `string`           | optional | Trimmed; 2–80 characters                |
| `bio`         | `string`           | optional | Trimmed; max 1000 characters            |
| `avatarUrl`   | `string`           | optional | Trimmed; must be a valid URL            |
| `links`       | `{ label, url }[]` | optional | Max 8 items; see `links[]` fields above |
| `perks`       | `CreatorPerk[]`    | optional | Max 10 items                            |

### `UpdateCreatorProfileSchema` — alternate update shape (legacy module)

Defined in `src/modules/creators/creators.schemas.ts`. Uses `.strict()` — unknown
keys are rejected.

| Field         | Type            | Required | Constraints                    |
| :------------ | :-------------- | :------- | :----------------------------- |
| `displayName` | `string`        | optional | 1–100 characters               |
| `bio`         | `string`        | optional | Max 1000 characters            |
| `avatarUrl`   | `string`        | optional | Valid URL or empty string `''` |
| `perkSummary` | `string`        | optional | Max 200 characters             |
| `perks`       | `CreatorPerk[]` | optional | —                              |

### `CreateCreatorProfileDto` — registration (TypeScript type)

Used when creating a new creator profile. No dedicated Zod schema exists yet.

| Field         | Type            | Required     | Constraints                                                           |
| :------------ | :-------------- | :----------- | :-------------------------------------------------------------------- |
| `handle`      | `string`        | **required** | Unique in DB; slug helpers exist but are not enforced at schema layer |
| `displayName` | `string`        | **required** | —                                                                     |
| `bio`         | `string`        | optional     | —                                                                     |
| `avatarUrl`   | `string`        | optional     | —                                                                     |
| `perkSummary` | `string`        | optional     | —                                                                     |
| `perks`       | `CreatorPerk[]` | optional     | —                                                                     |

### Admin metadata update

| Field        | Type      | Required | Constraints                       |
| :----------- | :-------- | :------- | :-------------------------------- |
| `isVerified` | `boolean` | optional | Updated via admin controller only |

---

## Read response shapes

### Profile read — `GET /api/v1/creators/:creatorId/profile`

| Field                        | Type                          | Required | Notes                               |
| :--------------------------- | :---------------------------- | :------- | :---------------------------------- |
| `creatorId`                  | `string`                      | yes      | Resolved profile ID                 |
| `displayName`                | `string \| null`              | yes      | `null` when absent                  |
| `bio`                        | `string \| null`              | yes      | `null` when absent                  |
| `avatarUrl`                  | `string \| null`              | yes      | Valid URL or `null`                 |
| `perks`                      | `CreatorPerk[]`               | optional | Omitted or empty when none          |
| `links`                      | `{ label, url }[]`            | yes      | Empty array `[]` when none          |
| `metadata.source`            | `'placeholder' \| 'database'` | yes      | Indicates data origin               |
| `metadata.isProfileComplete` | `boolean`                     | yes      | Derived from presence of key fields |

### List item — `GET /api/v1/creators`

Projected via `CREATOR_LIST_DEFAULT_SELECT`.

| Field         | Type      | Required | Notes                                      |
| :------------ | :-------- | :------- | :----------------------------------------- |
| `id`          | `string`  | yes      | —                                          |
| `handle`      | `string`  | yes      | —                                          |
| `displayName` | `string`  | yes      | Serialized as `name`; `null` when absent   |
| `avatarUrl`   | `string`  | yes      | Serialized as `avatar`; `null` when absent |
| `isVerified`  | `boolean` | yes      | —                                          |

### Detail stats — `PublicCreatorStats`

Computed metrics, not stored on the profile record.

| Field            | Type     | Required | Purpose                       |
| :--------------- | :------- | :------- | :---------------------------- |
| `holderCount`    | `number` | yes      | Number of key holders         |
| `totalSupply`    | `number` | yes      | Total keys issued             |
| `totalVolume`    | `number` | yes      | Cumulative trading volume     |
| `lastActivityAt` | `Date`   | optional | Most recent on-chain activity |

---

## Query parameters — `GET /api/v1/creators`

See [Creator List Query Parameter Precedence](../api/creator-list-query-precedence.md)
for full precedence rules.

| Parameter  | Type    | Required | Default     | Constraints                                             |
| :--------- | :------ | :------- | :---------- | :------------------------------------------------------ |
| `limit`    | integer | optional | `20`        | 1–100                                                   |
| `offset`   | integer | optional | `0`         | ≥ 0                                                     |
| `sort`     | enum    | optional | `createdAt` | `createdAt`, `updatedAt`, `displayName`, `handle`       |
| `order`    | enum    | optional | `desc`      | `asc` or `desc`                                         |
| `verified` | boolean | optional | absent      | Filter by verification status                           |
| `search`   | string  | optional | absent      | Trimmed and normalized; matches display name and handle |
| `include`  | string  | optional | absent      | Comma-separated extra data (e.g. `stats`)               |

---

## Route parameters

| Parameter   | Schema                       | Required | Constraints                                      |
| :---------- | :--------------------------- | :------- | :----------------------------------------------- |
| `creatorId` | `CreatorProfileParamsSchema` | yes      | Trimmed; 1–128 characters; empty string rejected |

---

## Required vs optional summary

| Context              | Required fields                       | Conditionally required                        | Optional fields                                          |
| :------------------- | :------------------------------------ | :-------------------------------------------- | :------------------------------------------------------- |
| DB create (seed)     | `userId`, `handle`, `displayName`     | —                                             | `bio`, `avatarUrl`, `perkSummary`, `perks`, `isVerified` |
| Profile upsert (PUT) | — (all fields optional)               | Each supplied field must meet its constraints | `displayName`, `bio`, `avatarUrl`, `links`, `perks`      |
| Profile create (DTO) | `handle`, `displayName`               | —                                             | `bio`, `avatarUrl`, `perkSummary`, `perks`               |
| Perk object          | `title`, `description`                | —                                             | `id`, `icon`                                             |
| Link object          | `label`, `url` (when link is present) | —                                             | —                                                        |

---

## Null vs absent conventions

From `src/modules/creators/creators.serializers.ts`:

- **List responses** use `null` for missing scalar fields (`name`, `avatar`).
- **Detail responses** use `null` for empty scalars and `[]` for empty collections.
- **Write payloads** omit fields the caller does not intend to change.

---

## Known divergences

These inconsistencies exist across layers and should be resolved in future
schema consolidation work:

| Topic                    | Divergence                                                                                          |
| :----------------------- | :-------------------------------------------------------------------------------------------------- |
| `displayName` max length | Prisma: none; profile upsert: 80; legacy update schema: 100                                         |
| `handle` validation      | DB `@unique` only; no Zod create schema; slug helpers in `src/utils/slug.utils.ts` are not enforced |
| `perkSummary`            | Stored in Prisma; not in profile upsert schema                                                      |
| `links`                  | API contract only; not yet in Prisma model                                                          |
| `CreatorPerkSchema`      | Duplicated in `creator-profile.schemas.ts` and `creators.schemas.ts`                                |
