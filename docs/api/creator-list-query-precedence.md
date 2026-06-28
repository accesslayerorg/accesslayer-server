# Creator List Query Parameter Precedence

`GET /api/v1/creators` accepts several query parameters for pagination, sorting,
and filtering. When parameters overlap or conflict, the rules below determine
which value takes effect.

## Parameter reference

| Parameter  | Type              | Default      | Notes                                                    |
| :--------- | :---------------- | :----------- | :------------------------------------------------------- |
| `limit`    | integer (1–100)   | `20`         | Number of results per page                               |
| `offset`   | integer (≥ 0)     | `0`          | Number of results to skip                                |
| `sort`     | enum              | `createdAt`  | Field used to order results                              |
| `order`    | `asc` \| `desc`   | `desc`       | Direction applied to the `sort` field                    |
| `verified` | boolean           | _(absent)_   | Filter by creator verification status                    |
| `search`   | string            | _(absent)_   | Full-text filter applied to display name and handle      |
| `include`  | comma-separated   | _(absent)_   | Extra data to embed in each result (e.g. `stats`)        |

## Precedence rules

### `sort` and `order` are always applied together

`order` has no effect unless a `sort` field is present. When `sort` is omitted,
the default field (`createdAt`) and the default direction (`desc`) are used.
If `sort` is supplied without `order`, `order` defaults to `desc`.

```
sort=displayName             → sort by displayName desc  (order defaults)
sort=displayName&order=asc   → sort by displayName asc
order=asc                    → sort by createdAt asc     (sort defaults)
```

### Cursor-based navigation overrides `offset`

When a `cursor` value is present (future feature, type-checked at the schema
level), it takes precedence over `offset`. The `limit` value continues to
control page size regardless of which pagination mode is active.

While the endpoint currently uses offset pagination, the schema reserves the
`cursor` field for forward compatibility. Supplying both `cursor` and `offset`
is not recommended; `cursor` will win when both are non-empty.

### `search` and `verified` are independent filters — both are applied

`search` and `verified` narrow the result set independently. When both are
present the response contains only creators that match **both** conditions.
Neither parameter takes precedence over the other; they are ANDed together in
the database query.

```
verified=true&search=jazz → creators who are verified AND whose name/handle
                            contains "jazz"
```

### `search` is applied before sorting

Sorting is applied to the filtered result set. Specifying `search=jazz` with
`sort=displayName` returns matching creators sorted alphabetically — not all
creators sorted alphabetically narrowed to those matching "jazz".

### `verified` is applied before `search`

There is no practical difference in the result when both are present (AND
semantics), but internally `verified` is resolved first in the filter
combinator. The ordering is an implementation detail and may not be relied upon
for correctness.

### `limit` and `offset` operate on the fully-filtered, sorted result set

`limit` and `offset` are applied **after** all filters and sorting. Setting
`offset=40&limit=20` skips the first 40 matching creators and returns the next
20, not 20 creators from position 40 in the unfiltered list.

### Unrecognized parameters are rejected

The query schema uses `strict()` mode. Any parameter not listed in the table
above causes a `400 Bad Request` with a structured error body listing the
unknown keys. Unknown parameters are never silently ignored.

### Repeated parameters use the first value

When the same parameter appears more than once in the query string
(e.g. `sort=createdAt&sort=displayName`), only the first occurrence is used.
This is consistent with how Express parses repeated scalar query params.

## Behaviour summary table

| Supplied params                        | Effective behaviour                               |
| :------------------------------------- | :------------------------------------------------ |
| _(no params)_                          | `createdAt desc`, page 1 (limit 20, offset 0)     |
| `sort=displayName`                     | `displayName desc`                                |
| `order=asc`                            | `createdAt asc`                                   |
| `sort=displayName&order=asc`           | `displayName asc`                                 |
| `verified=true`                        | verified creators only, `createdAt desc`          |
| `search=jazz`                          | creators matching "jazz", `createdAt desc`        |
| `verified=true&search=jazz`            | verified creators matching "jazz", `createdAt desc` |
| `verified=true&sort=displayName`       | verified creators sorted `displayName desc`       |
| `limit=10&offset=20`                   | page 3 at 10-per-page                             |
| `unknownParam=x`                       | `400 Bad Request`                                 |

## Related files

- [`src/modules/creators/creators.schemas.ts`](../../src/modules/creators/creators.schemas.ts) — Zod validation schema with defaults
- [`src/modules/creators/creators.filter.ts`](../../src/modules/creators/creators.filter.ts) — Filter parsing and unknown-key rejection
- [`src/modules/creators/creator-feed-filter-combinator.utils.ts`](../../src/modules/creators/creator-feed-filter-combinator.utils.ts) — Prisma `where` clause builder
- [`src/constants/creator-list-sort.constants.ts`](../../src/constants/creator-list-sort.constants.ts) — Allowed sort fields and defaults
- [`src/modules/creators/creators.routes.ts`](../../src/modules/creators/creators.routes.ts) — Route handler wiring
