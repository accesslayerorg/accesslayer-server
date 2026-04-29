# Boolean Query Parser

The API uses a consistent boolean query parser across all endpoints that accept boolean-like query parameters (e.g. `verified`, `isActive`).

## Accepted values

| Input      | Parsed as                               |
| ---------- | --------------------------------------- |
| `true`     | `true`                                  |
| `1`        | `true`                                  |
| `yes`      | `true`                                  |
| `on`       | `true`                                  |
| `false`    | `false`                                 |
| `0`        | `false`                                 |
| `no`       | `false`                                 |
| `off`      | `false`                                 |
| _(absent)_ | `null` — caller applies its own default |

Values are **case-insensitive** (`True`, `TRUE`, `On` all parse correctly).  
Leading and trailing whitespace is stripped before comparison.

## Examples

```http
GET /api/v1/creators?verified=true    → verified: true
GET /api/v1/creators?verified=1       → verified: true
GET /api/v1/creators?verified=yes     → verified: true
GET /api/v1/creators?verified=on      → verified: true
GET /api/v1/creators?verified=false   → verified: false
GET /api/v1/creators?verified=0       → verified: false
GET /api/v1/creators?verified=no      → verified: false
GET /api/v1/creators?verified=off     → verified: false
GET /api/v1/creators                  → verified: absent (endpoint default applies)
```

## Error response

Any value not in the accepted list produces a `400 Bad Request`:

```json
{
   "success": false,
   "code": "VALIDATION_ERROR",
   "message": "Invalid boolean value for query parameter \"verified\": received \"maybe\". Accepted values: \"true\", \"false\", \"1\", \"0\", \"yes\", \"no\", \"on\", \"off\"."
}
```

## Query validation integration

Boolean query parameters are validated at the schema level before reaching controller logic. If a request carries an invalid boolean value the endpoint returns a `400` before any database access.

See the query validation schemas in `src/modules/creators/creators.schemas.ts` for how parameters are parsed at the route level, and `src/utils/parseBoolean.utils.ts` for the shared parser used across endpoints.

## Implementation reference

```typescript
import {
   parseBoolean,
   parseBooleanWithDefault,
} from '../utils/parseBoolean.utils';

// Returns true | false | null (null when param absent)
const verified = parseBoolean('verified', req.query.verified);

// Returns true | false; falls back to false when param absent
const verified = parseBooleanWithDefault('verified', req.query.verified, false);
```
