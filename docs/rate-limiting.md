# Rate Limiting Configuration

This document outlines the rate limiting mechanisms in place for the Access Layer API, their default thresholds, behavior, and instructions for configuring custom per-endpoint limits.

## Overview

The Access Layer server implements rate limiting to protect the system against resource exhaustion, Denial-of-Service (DoS) attacks, brute-force attempts, and scraper activity.

Rate limiting is implemented using the `express-rate-limit` middleware, which registers a global limiter applied to all incoming API requests (except for health checks and doc serving paths that bypass it or have their own handling).

- **Middleware Location:** [rate.middleware.ts](file:///c:/Users/PC/Desktop/accesslayer-server/src/middlewares/rate.middleware.ts)
- **Application Setup:** [app.ts](file:///c:/Users/PC/Desktop/accesslayer-server/src/app.ts) (mounted via `app.use(appRateLimit)`)

---

## Default Thresholds

The default rate limit configuration uses a sliding/fixed window rate limiter based on the client IP address.

| Environment | Limit (Requests) | Window Size | Units | Description |
| :--- | :--- | :--- | :--- | :--- |
| **Production** | `1,000` | `15` | minutes | Standard rate limit for API consumers |
| **Development** / **Test** | `10,000` | `15` | minutes | Relaxed rate limit to facilitate local testing and manual integration tests |

The window duration is fixed in code:
- **Default Window:** `15` minutes (`RATE_LIMIT_WINDOW_MS` = `15 * 60 * 1000` milliseconds).
- **Production Limit:** `1,000` requests per window.
- **Development/Test Limit:** `10,000` requests per window.

---

## Standard Rate Limit Headers

Every successful and failed API response includes standard HTTP headers defined by the IETF draft RFC for rate limiting. These headers allow client applications to dynamically adjust their request rates.

| Header Name | Type | Description |
| :--- | :--- | :--- |
| `RateLimit-Limit` | Integer | The maximum number of allowed requests in the window. |
| `RateLimit-Remaining` | Integer | The number of remaining requests allowed in the current window. |
| `RateLimit-Reset` | Integer | The time at which the rate limit resets (in Unix epoch seconds). |

> [!NOTE]
> The legacy headers (e.g. `X-RateLimit-*`) are explicitly disabled (`legacyHeaders: false`) to comply with modern API standards.

---

## Rate-Exceeded Response Behavior

When a client exceeds the allowed request threshold, the server rejects the request immediately without hitting controllers or the database.

### Response Metadata

- **HTTP Status Code:** `429 Too Many Requests`
- **Response Headers:**
  - `Retry-After`: The duration in seconds that the client must wait before making another request (e.g., `900` seconds if a client is blocked at the start of a window).

### Response Body

The response returns a JSON object following the API error pattern:

```json
{
  "type": "RATE_LIMIT_EXCEEDED",
  "message": "Too many requests, please try again later.",
  "retryAfterSeconds": 900,
  "timestamp": "2026-05-29T20:00:00.000Z"
}
```

- **`type`**: Always returns `'RATE_LIMIT_EXCEEDED'`.
- **`message`**: A human-readable message instructing the client.
- **`retryAfterSeconds`**: Integer representing the remaining seconds of the block.
- **`timestamp`**: ISO-8601 string of the exact date and time the block occurred.

---

## Custom Per-Endpoint Thresholds

Currently, **all endpoints share the global rate limit**, and there are no custom per-endpoint thresholds configured. 

If you are developing new endpoints that are computationally expensive or susceptible to abuse (e.g., wallet authentication, payment initiation, email dispatch, heavy database query searches), you should define custom limits.

### Adding a Custom Rate Limiter

To apply custom rate limits to a specific route or group of routes:

1. Import the configuration and rate limit helpers.
2. Define a dedicated rate limiter instance.
3. Apply the rate limiter as a route middleware.

#### Example implementation:

```typescript
import rateLimit from 'express-rate-limit';
import { envConfig } from '../../config';
import { sendRateLimitError } from '../../utils/rate-limit-response.utils';

// Define the custom window and limit (e.g., 50 requests per 5 minutes)
const CUSTOM_WINDOW_MS = 5 * 60 * 1000;

export const expensiveEndpointLimit = rateLimit({
   windowMs: CUSTOM_WINDOW_MS,
   max: envConfig.MODE === 'production' ? 50 : 500,
   standardHeaders: true,
   legacyHeaders: false,
   handler: (_req, res) => {
      sendRateLimitError(res, CUSTOM_WINDOW_MS / 1000);
   },
});
```

Mount it on your target router:

```typescript
import { Router } from 'express';
import { expensiveEndpointLimit } from './expensive.middleware';

const router = Router();

// Mount custom rate limiter middleware before the controller
router.post('/process-transaction', expensiveEndpointLimit, processTransactionController);

export default router;
```

---

## Trust Proxy Configuration

Because the Access Layer is deployed behind load balancers or reverse proxies (like Nginx or Cloudflare), the server is configured to trust upstream proxy headers to correctly identify client IP addresses:

```typescript
app.set('trust proxy', 1);
```

This prevents the rate limiting middleware from rate limiting the proxy's IP address instead of the client's actual IP address.

---

## Related Documentation

- [Configuration Guide](./configuration.md) - Loading environment configurations.
- [Error Code Registry](./ERROR_CODE_REGISTRY.md) - Standard API error shapes.
