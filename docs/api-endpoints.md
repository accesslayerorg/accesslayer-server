# API Endpoint Reference

Base URL: `http://localhost:3000/api/v1`

## Health Endpoints

### GET /health

Simple health check for load balancers.

- **Auth:** None
- **Response:** `200 OK`

```json
{
   "success": true,
   "message": "OK",
   "timestamp": "2025-01-15T10:30:00.000Z"
}
```

### GET /health/ready

Readiness check with dependency probes.

- **Auth:** None
- **Response:** `200 OK` or `503 Service Unavailable`

```json
{
   "ready": true,
   "timestamp": "2025-01-15T10:30:00.000Z",
   "checks": [
      { "name": "database", "status": "ok", "latencyMs": 12 },
      { "name": "cache", "status": "ok" }
   ]
}
```

### GET /health/detailed

Full diagnostics including memory and system info.

- **Auth:** None
- **Response:** `200 OK`

```json
{
   "success": true,
   "message": "Access Layer server is running",
   "timestamp": "2025-01-15T10:30:00.000Z",
   "version": "1.0.0",
   "environment": "development",
   "uptime": 12345.67,
   "memory": { "used": 45.23, "total": 128.5 },
   "system": { "platform": "darwin", "nodeVersion": "v20.10.0" },
   "database": { "status": "connected", "responseTime": 12 },
   "services": [
      { "name": "API Server", "status": "healthy" },
      { "name": "Database", "status": "healthy" }
   ]
}
```

---

## Auth Endpoints

### POST /auth/login

Authenticate a user.

- **Auth:** None
- **Body:**

```json
{
   "email": "user@example.com",
   "password": "securepassword"
}
```

- **Response:** `200 OK`

### POST /auth/register

Register a new user.

- **Auth:** None
- **Body:**

```json
{
   "email": "user@example.com",
   "password": "securepassword",
   "name": "User Name"
}
```

- **Response:** `201 Created`

---

## Config Endpoints

### GET /config

Get protocol bootstrap configuration.

- **Auth:** None
- **Response:** `200 OK`

```json
{
   "network": "testnet",
   "contractAddress": "..."
}
```

---

## Creators Endpoints

### GET /creators

List all creators with pagination.

- **Auth:** None
- **Query Params:**
   - `page` (number, default: 1)
   - `limit` (number, default: 10)
- **Response:** `200 OK`

```json
{
  "creators": [...],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 100
  }
}
```

### GET /creators/:id/stats

Get public stats for a specific creator.

- **Auth:** None
- **Response:** `200 OK`

```json
{
   "creatorId": "...",
   "totalSales": 150,
   "totalEarnings": 12500.5
}
```

---

## Creator Profile Endpoints

### GET /creators/:wallet

Get the public profile associated with a Stellar wallet and aggregated stats
for every creator key deployed by that wallet.

- **Auth:** None
- **Stats:** `totalKeys`, `totalHolders`, and `totalTradingVolume` (in stroops)
- **Stats cache:** 60 seconds; creator registration invalidates the wallet cache

### GET /creators/:wallet/keys

Get creator keys deployed by a Stellar wallet, ordered newest first. Supports
`limit` (1-100, default 20) and an opaque `cursor` from the prior response.

- **Auth:** None
- **Pagination:** `items`, `nextCursor`, `hasMore`, and `limit`

### GET /creators/:creatorId/profile

Get creator profile scaffold payload.

- **Auth:** None
- **Response:** `200 OK`

```json
{
   "creatorId": "...",
   "displayName": "Creator Name",
   "bio": "...",
   "avatarUrl": "..."
}
```

### PUT /creators/:creatorId/profile

Upsert creator profile.

- **Auth:** Wallet ownership required
- **Headers:**
   - `x-wallet-address: <wallet_address>` (must match creator)
- **Body:**

```json
{
   "displayName": "New Name",
   "bio": "Updated bio",
   "avatarUrl": "https://..."
}
```

- **Response:** `200 OK`

---

## Metrics Endpoints

### GET /metrics/queues

Queue depth metrics for indexer workers.

- **Auth:** None
- **Response:** `200 OK`

```json
{
   "queues": {
      "indexer": { "depth": 42, "processing": 5 },
      "notifications": { "depth": 10, "processing": 2 }
   }
}
```

---

## Admin Endpoints

### PATCH /admin/creators/:id/metadata

Update creator metadata.

- **Auth:** Admin required
- **Body:**

```json
{
   "metadata": { "key": "value" }
}
```

- **Response:** `200 OK`

### POST /admin/indexer/replay

Replay indexer events.

- **Auth:** Admin required
- **Response:** `200 OK`

### GET /admin/flash-loan-violations

Wallets that triggered the on-chain flash loan guard (#938), sorted by
violation frequency (most attempts first) over the configured cooldown
window, with alert and auto-suspension state.

- **Auth:** Admin required
- **Query:** `limit` (default `50`, max `100`), `offset` (default `0`),
  `include_cleared` (default `false`), `recent_limit` (default `5`, max `25`)
- **Response:** `200 OK`

```json
{
   "success": true,
   "data": {
      "threshold": 3,
      "autoSuspendEnabled": true,
      "cooldownHours": 24,
      "total": 1,
      "limit": 50,
      "offset": 0,
      "violations": [
         {
            "walletAddress": "GABCD...",
            "violationCount": 4,
            "keyIds": ["key-1"],
            "firstViolationAt": "2026-09-26T09:00:00.000Z",
            "lastViolationAt": "2026-09-26T11:30:00.000Z",
            "alerted": true,
            "alertedAt": "2026-09-26T09:45:00.000Z",
            "alertCount": 2,
            "suspended": true,
            "suspendedAt": "2026-09-26T09:45:00.000Z",
            "suspensionExpiresAt": null,
            "recentViolations": [
               {
                  "keyId": "key-1",
                  "ledger": 123456,
                  "txHash": "abc123",
                  "eventIndex": 0,
                  "occurredAt": "2026-09-26T11:30:00.000Z",
                  "clearedAt": null
               }
            ]
         }
      ]
   }
}
```

---

## Common Headers

| Header             | Description                               |
| ------------------ | ----------------------------------------- |
| `x-wallet-address` | Wallet address for ownership verification |
| `Authorization`    | Bearer token for authenticated requests   |
| `Content-Type`     | `application/json`                        |

## Error Responses

```json
{
   "success": false,
   "message": "Error description",
   "error": "Detailed error (dev only)"
}
```

| Status | Description                    |
| ------ | ------------------------------ |
| 400    | Bad request / validation error |
| 401    | Unauthorized                   |
| 403    | Forbidden                      |
| 404    | Not found                      |
| 429    | Rate limit exceeded            |
| 500    | Internal server error          |

---

See [Local Setup](./local-setup.md) for development environment configuration.
