# Rate limiting configuration (defaults, protected endpoints, and error format)

This document describes how the Access Layer server applies rate limiting, what defaults are used, which endpoints are protected by default, and how to interpret/handle rate-limit error responses.

> Note: This codebase currently uses **one global limiter** (no per-endpoint limit overrides via configuration).

---

## Where rate limiting is applied

Rate limiting is implemented with [`express-rate-limit`](https://www.npmjs.com/package/express-rate-limit).

- **Middleware:** `src/middlewares/rate.middleware.ts`
- **Mounted in:** `src/app.ts` via `app.use(appRateLimit)`
- **Effect:** the limiter runs for requests after middleware setup and will therefore apply to routes under `/api/v1/...`.

The app also sets:

- `app.set('trust proxy', 1)`

This ensures the limiter keys off the **real client IP** when the server is behind a reverse proxy / load balancer.

---

## Protected endpoints (default)

Because the limiter is mounted globally, these endpoints are protected **by default** simply by being API routes:

### Alert registration

- `POST /api/v1/alerts` (alert creation/registration)

### Webhook registration

- `POST /api/v1/webhooks` (webhook creation/registration)

### Mutation routes

- Any route that **mutates state** (e.g., `POST`, `PUT`, `PATCH`, `DELETE` under `/api/v1/...`) is subject to the global rate limit.

> There are no exceptions implemented in the current rate-limit middleware layer (e.g., no explicit `excludeRoute` / `skip` logic).

---

## Default limits and time window

The limiter uses the following values (keyed by client IP):

| MODE                                   | Max requests | Window | Units   |
| -------------------------------------- | -----------: | -----: | ------- |
| `production`                           |       `1000` |   `15` | minutes |
| `development` / `test` (anything else) |      `10000` |   `15` | minutes |

Code constants:

- Window size: `RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000`
- Max: `envConfig.MODE === 'production' ? 1000 : 10000`

---

## Headers sent to help clients throttle

The middleware enables standard RFC rate-limit headers:

- `RateLimit-Limit`
- `RateLimit-Remaining`
- `RateLimit-Reset` (Unix epoch seconds)

Legacy `X-RateLimit-*` headers are disabled.

---

## Rate-limit error handling

When the client exceeds the limit, the API responds immediately with:

### HTTP status

- **429 Too Many Requests**

### Response headers

- `Retry-After`: number of **seconds** to wait before retrying

### Response body (JSON shape)

The body follows this schema:

```json
{
   "type": "RATE_LIMIT_EXCEEDED",
   "message": "Too many requests, please try again later.",
   "retryAfterSeconds": 900,
   "timestamp": "2026-05-29T20:00:00.000Z"
}
```

Where:

- `type`: always `"RATE_LIMIT_EXCEEDED"`
- `message`: human-readable guidance
- `retryAfterSeconds`: integer seconds (derived from the fixed window in code)
- `timestamp`: ISO-8601 time the limit was triggered

The error formatter lives at:

- `src/utils/rate-limit-response.utils.ts`

---

## Overriding limits (staging vs production)

### Current behavior (configuration)

The only supported environment-based change is controlled by:

- `MODE`

- `MODE=production` ⇒ `1000` requests / 15 minutes per IP
- `MODE!=production` ⇒ `10000` requests / 15 minutes per IP

There are **no documented env vars** (including in `.env.example`) for per-route rate limit tuning.

### Per-endpoint overrides

Per-endpoint overrides would require code changes (e.g., additional `express-rate-limit` middleware instances mounted on specific routers/routes). This repo currently applies **one global limiter**, so per-route configuration is not available via environment config.

---

## Related docs

- [docs/configuration.md](./configuration.md)
- [docs/rate-limiting.md](./rate-limiting.md)
- [docs/error-response.md](./error-response.md)
