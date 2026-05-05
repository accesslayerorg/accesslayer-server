# Creator Query Normalization

This document describes how raw query parameters for creator lookup endpoints are
normalized before use. See [`src/utils/public-query-parse.utils.ts`](../../src/utils/public-query-parse.utils.ts)
for the generic Zod-based validation layer that wraps these parameters.

## Overview

Creator lookup endpoints accept three optional identifier fields. Each field is
read directly from `req.query` by
[`parseCreatorPublicQuery`](../../src/utils/creator-public-query.util.ts) and
forwarded to the service layer as-is. No coercion, trimming, or case-folding is
applied at the utility level — normalization is the caller's responsibility.

| Query key        | Constant                                    | Typical format          |
| :--------------- | :------------------------------------------ | :---------------------- |
| `creatorId`      | `CREATOR_PUBLIC_QUERY_KEYS.CREATOR_ID`      | UUID v4 string          |
| `creatorAddress` | `CREATOR_PUBLIC_QUERY_KEYS.CREATOR_ADDRESS` | Stellar public key (G…) |
| `username`       | `CREATOR_PUBLIC_QUERY_KEYS.USERNAME`        | Lowercase handle        |

## Field-by-field rules

### `creatorId`

Identifies a creator by their internal database UUID.

**Rules applied by callers before querying:**

- Must be a valid UUID v4 (`xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`).
- Leading/trailing whitespace should be stripped.
- Case is insignificant for UUID comparison but the stored value is lowercase —
  normalize to lowercase before querying.

**Before / after examples:**

| Raw query string          | Normalized value used in query       |
| :------------------------ | :----------------------------------- |
| `creatorId=ABC-123`       | rejected — not a valid UUID          |
| `creatorId= 3f6a1b2c-…  ` | `3f6a1b2c-…` (whitespace stripped)   |
| `creatorId=3F6A1B2C-…`    | `3f6a1b2c-…` (lowercased)            |
| `creatorId=3f6a1b2c-…`    | `3f6a1b2c-…` (unchanged, valid UUID) |

---

### `creatorAddress`

Identifies a creator by their linked Stellar public key.

**Rules applied by callers before querying:**

- Must start with `G` and be 56 characters (Stellar ed25519 public key format).
- Leading/trailing whitespace should be stripped.
- Stellar addresses are case-sensitive — do **not** normalize case.

**Before / after examples:**

| Raw query string            | Normalized value used in query                  |
| :-------------------------- | :---------------------------------------------- |
| `creatorAddress= GABC…XYZ ` | `GABC…XYZ` (whitespace stripped)                |
| `creatorAddress=gabc…xyz`   | rejected — lowercase Stellar address is invalid |
| `creatorAddress=GABC…XYZ`   | `GABC…XYZ` (unchanged, valid address)           |
| `creatorAddress=SHORTKEY`   | rejected — not 56 characters                    |

---

### `username`

Identifies a creator by their public handle.

**Rules applied by callers before querying:**

- Leading/trailing whitespace should be stripped.
- Stored usernames are lowercase — normalize to lowercase before querying so
  that `Alice`, `alice`, and `ALICE` all resolve to the same creator.
- Empty string after trimming is treated as absent (no filter applied).

**Before / after examples:**

| Raw query string       | Normalized value used in query |
| :--------------------- | :----------------------------- |
| `username=Alice`       | `alice`                        |
| `username=  Alice  `   | `alice` (trimmed + lowercased) |
| `username=MUSIC_MAKER` | `music_maker`                  |
| `username=`            | _(parameter ignored)_          |

## Validation integration

These normalization rules are enforced at the route/controller layer using the
`parsePublicQuery` helper from
[`src/utils/public-query-parse.utils.ts`](../../src/utils/public-query-parse.utils.ts).
A Zod schema wraps each field, applies `.trim()` and `.toLowerCase()` transforms
where appropriate, and returns a typed `{ ok: true, data }` result or a
structured `{ ok: false, details }` error array suitable for a `400` response.

```ts
// Example schema used with parsePublicQuery
const creatorLookupSchema = z.object({
   creatorId: z.string().uuid().optional(),
   creatorAddress: z.string().length(56).startsWith('G').optional(),
   username: z.string().trim().toLowerCase().optional(),
});
```

## Related files

- [`src/utils/creator-public-query.util.ts`](../../src/utils/creator-public-query.util.ts) — raw query extraction
- [`src/utils/public-query-parse.utils.ts`](../../src/utils/public-query-parse.utils.ts) — Zod-based parse + validation
- [`src/constants/creator-public-query.constants.ts`](../../src/constants/creator-public-query.constants.ts) — query key constants
- [`src/modules/creator/`](../../src/modules/creator/) — creator module routes and services
