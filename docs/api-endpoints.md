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

### GET /creators/:wallet/social

Get the on-chain synced social metadata for a creator, keyed by wallet
address, creator id, or handle (`:wallet` accepts any of the three).

- **Auth:** None
- **Headers:** `Cache-Control: public, max-age=60` (short TTL so on-chain
  social updates propagate within ~60 seconds)
- **Response:** `200 OK`

```json
{
   "success": true,
   "data": {
      "creatorId": "...",
      "handle": "ada",
      "wallet": "GWALLET...",
      "displayName": "Ada Artist",
      "bio": "On-chain bio",
      "avatarUrl": "https://gateway.pinata.cloud/ipfs/bafy...",
      "avatarCid": "bafy...",
      "links": [{ "label": "X", "url": "https://x.com/ada" }],
      "synced": true,
      "updatedAt": "2026-10-17T10:00:00.000Z",
      "source": { "ledger": 500, "txHash": "tx-social-1", "eventIndex": 0 }
   }
}
```

When no `SocialMetadataUpdated` event has been indexed for the creator yet, the
endpoint still returns `200 OK` with `synced: false`, `links: []`, and `null`
display/bio/avatar fields plus a `null` `source`. The avatar is resolved from
its IPFS CID via `PINATA_GATEWAY_URL`. See
[social-metadata-sync.md](./social-metadata-sync.md) for the sync details.

## Creator Revenue Distribution Endpoints

### GET /keys/:keyId/revenue-distributions

Return indexed revenue distributions for a creator key, newest first.

- **Auth:** None
- **Query Params:** `limit` (1-100, default 50), `cursor` (distribution cursor)
- **Response:** Each entry includes `distributionId`, `distributedAt`, `amount`,
  and `holderCount`, along with cursor pagination metadata.
- **Cache:** 60 seconds; invalidated when a new distribution is indexed.

### GET /keys/:keyId/revenue-distributions/:wallet

Return the wallet's claimable and claimed amounts for each indexed distribution.

- **Auth:** None
- **Response:** Distribution entries include `claimableAmount` and
  `claimedAmount` in addition to the distribution date, amount, and holder count.
- **Cache:** 60 seconds; invalidated when a distribution or claim is indexed.

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

## Invoice Endpoints

### GET /invoices/compare

Compare metrics for up to two invoices in a single request. Accepts a
comma-separated `ids` query parameter; metrics are returned grouped by invoice
ID. Responses are cached for 30 seconds per ID combination.

- **Auth:** None
- **Query:** `ids` - comma-separated invoice IDs (1 or 2; more returns `400`)
- **Response:** `200 OK`

```
GET /invoices/compare?ids=cm123,cm456
```

```json
{
   "success": true,
   "data": {
      "invoice_ids": ["cm123", "cm456"],
      "invoices": {
         "cm123": {
            "invoice_id": "cm123",
            "seller_wallet": "GSELLER...",
            "currency": "USDC",
            "status": "FUNDED",
            "amount": "1000",
            "rate": "0.05",
            "maturity": "2026-12-31T00:00:00.000Z",
            "risk_rating": "A",
            "funding_progress": "1",
            "seller_stats": {
               "wallet": "GSELLER...",
               "invoice_count": 4,
               "total_amount": "12500",
               "average_rate": "0.062"
            }
         }
      }
   }
}
```

---

### GET /invoices/:invoice_id/early-incentive

Early funding incentive slot status for an invoice. `slots_filled` counts indexed
`EarlySlotFilled` events and is capped at `slots_total`. Configuration comes from
the most recent event. Responses are cached for 30 seconds.

- **Auth:** None
- **Response:** `200 OK`; `404` when the invoice does not exist. An invoice with
  no incentive configured returns `is_active: false`.

```json
{
   "success": true,
   "data": {
      "invoice_id": "cm123",
      "slots_total": 10,
      "slots_filled": 4,
      "slots_remaining": 6,
      "bonus_bps": 250,
      "is_active": true
   }
}
```

---

## Issuer Endpoints

### GET /issuers/:wallet/verification

Verification badge status for an issuer. `is_verified` is `false` for revoked,
expired, or never-verified issuers, and `tier` is `null` in those cases.
`days_remaining` is `null` for a grant with no expiry. Responses are cached for 60
seconds.

- **Auth:** None
- **Response:** `200 OK`; `400` for an invalid Stellar wallet

```json
{
   "success": true,
   "data": {
      "wallet": "GISSUER...",
      "is_verified": true,
      "tier": "GOLD",
      "expiry_timestamp": "2027-01-01T00:00:00.000Z",
      "days_remaining": 71
   }
}
```

### GET /issuers/verified

Paginated list of currently verified issuers.

- **Auth:** None
- **Query:** `page` (default `1`), `limit` (default `20`, max `100`)
- **Response:** `200 OK` with `meta` pagination

---

## Investor Endpoints

### GET /investors/:wallet/health-score

Portfolio health score for a wallet, read from the health-score contract's
`get_health_score` and cached for 5 minutes. `score` and `factors` are `null` for
a wallet with no portfolio. Requires `PORTFOLIO_HEALTH_CONTRACT_ID`; without it the
endpoint returns `503`.

- **Auth:** None
- **Response:** `200 OK`; `400` for an invalid wallet; `503` when the contract is
  not configured or the read fails

```json
{
   "success": true,
   "data": {
      "wallet": "GINVESTOR...",
      "score": 742,
      "factors": {
         "concentration_score": 80,
         "maturity_distribution_score": 70,
         "issuer_diversity_score": 65,
         "default_exposure_score": 90
      },
      "computed_at": "2026-10-21T10:00:00.000Z"
   }
}
```

---

## Admin Endpoints

### POST /admin/proposals

Create a new multisig proposal requiring multi-sig approval.

- **Auth:** Admin required
- **Body:**

```json
{
   "changeType": "update_fee",
   "payload": {
      "feeBps": 500,
      "treasuryAddress": "GATREASURYADDRESSFORACCESSLAYERTESTING123456789"
   },
   "threshold": 2,
   "totalSigners": 3
}
```

- **Response:** `201 Created`

```json
{
   "success": true,
   "data": {
      "id": "cm123...",
      "proposalId": "msig-1234567890-abc123",
      "changeType": "update_fee",
      "payload": {
         "feeBps": 500,
         "treasuryAddress": "GATREASURYADDRESSFORACCESSLAYERTESTING123456789"
      },
      "status": "pending",
      "threshold": 2,
      "totalSigners": 3,
      "proposedBy": "GAADMIN1WALLETADDRESSFORACCESSLAYERTESTING123456789",
      "proposedAt": "2026-09-27T10:30:00.000Z",
      "executedAt": null,
      "rejectedAt": null,
      "rejectedBy": null,
      "rejectionReason": null,
      "createdAt": "2026-09-27T10:30:00.000Z",
      "updatedAt": "2026-09-27T10:30:00.000Z",
      "signatures": [],
      "approvalCount": 0
   }
}
```

### GET /admin/proposals

List all multisig proposals with pagination and optional status filter.

- **Auth:** Admin required
- **Query Params:**
   - `status` (optional): `pending`, `executed`, or `rejected`
   - `page` (number, default: 1)
   - `limit` (number, default: 20, max: 100)
- **Response:** `200 OK`

```json
{
   "success": true,
   "data": {
      "items": [
         {
            "id": "cm123...",
            "proposalId": "msig-1234567890-abc123",
            "changeType": "update_fee",
            "payload": { "feeBps": 500 },
            "status": "pending",
            "threshold": 2,
            "totalSigners": 3,
            "proposedBy": "GAADMIN1WALLETADDRESSFORACCESSLAYERTESTING123456789",
            "proposedAt": "2026-09-27T10:30:00.000Z",
            "executedAt": null,
            "rejectedAt": null,
            "rejectedBy": null,
            "rejectionReason": null,
            "createdAt": "2026-09-27T10:30:00.000Z",
            "updatedAt": "2026-09-27T10:30:00.000Z",
            "signatures": [
               {
                  "id": "cm456...",
                  "proposalId": "msig-1234567890-abc123",
                  "signer": "GAADMIN1WALLETADDRESSFORACCESSLAYERTESTING123456789",
                  "signedAt": "2026-09-27T10:31:00.000Z"
               }
            ],
            "approvalCount": 1
         }
      ],
      "meta": {
         "page": 1,
         "limit": 20,
         "totalCount": 1,
         "totalPages": 1,
         "hasNextPage": false,
         "hasPrevPage": false
      }
   }
}
```

### GET /admin/proposals/:id

Get detailed information for a single multisig proposal including all signatures.

- **Auth:** Admin required
- **Response:** `200 OK`

```json
{
   "success": true,
   "data": {
      "id": "cm123...",
      "proposalId": "msig-1234567890-abc123",
      "changeType": "update_fee",
      "payload": { "feeBps": 500 },
      "status": "pending",
      "threshold": 2,
      "totalSigners": 3,
      "proposedBy": "GAADMIN1WALLETADDRESSFORACCESSLAYERTESTING123456789",
      "proposedAt": "2026-09-27T10:30:00.000Z",
      "executedAt": null,
      "rejectedAt": null,
      "rejectedBy": null,
      "rejectionReason": null,
      "createdAt": "2026-09-27T10:30:00.000Z",
      "updatedAt": "2026-09-27T10:30:00.000Z",
      "signatures": [
         {
            "id": "cm456...",
            "proposalId": "msig-1234567890-abc123",
            "signer": "GAADMIN1WALLETADDRESSFORACCESSLAYERTESTING123456789",
            "signedAt": "2026-09-27T10:31:00.000Z"
         }
      ],
      "approvalCount": 1
   }
}
```

- **Error Response:** `404 Not Found` if proposal does not exist

### POST /admin/proposals/:id/sign

Submit a signature/approval for a multisig proposal. When the threshold is reached, the proposal is automatically executed.

- **Auth:** Admin required (signer must be in ADMIN_MULTISIG_WALLETS)
- **Body:**

```json
{
   "signer": "GAADMIN1WALLETADDRESSFORACCESSLAYERTESTING123456789"
}
```

- **Response:** `200 OK`

```json
{
   "success": true,
   "data": {
      "proposalId": "msig-1234567890-abc123",
      "status": "executed",
      "approvalCount": 2,
      "threshold": 2,
      "executed": true,
      "signature": {
         "id": "cm789...",
         "proposalId": "msig-1234567890-abc123",
         "signer": "GAADMIN2WALLETADDRESSFORACCESSLAYERTESTING987654321",
         "signedAt": "2026-09-27T10:32:00.000Z"
      }
   }
}
```

- **Error Responses:**
   - `400 Bad Request` if proposal is not in `pending` state
   - `403 Forbidden` if signer is not authorized
   - `404 Not Found` if proposal does not exist
   - `409 Conflict` if signer has already signed

### POST /admin/proposals/:id/reject

Reject a multisig proposal.

- **Auth:** Admin required (rejector must be in ADMIN_MULTISIG_WALLETS)
- **Body:**

```json
{
   "rejector": "GAADMIN1WALLETADDRESSFORACCESSLAYERTESTING123456789",
   "reason": "Optional rejection reason"
}
```

- **Response:** `200 OK`

```json
{
   "success": true,
   "data": {
      "proposalId": "msig-1234567890-abc123",
      "status": "rejected",
      "rejectedAt": "2026-09-27T10:33:00.000Z",
      "rejectedBy": "GAADMIN1WALLETADDRESSFORACCESSLAYERTESTING123456789",
      "rejectionReason": "Optional rejection reason"
   }
}
```

- **Error Responses:**
   - `400 Bad Request` if proposal is not in `pending` state
   - `403 Forbidden` if rejector is not authorized
   - `404 Not Found` if proposal does not exist

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

### GET /admin/treasury

Platform treasury balance for the admin dashboard. `total_balance` is gross fee
inflow minus allocations. `per_source_breakdown` is gross inflow per source;
allocations are not attributed to a source. Amounts are strings in stroops.
Cached for 60 seconds.

- **Auth:** Admin JWT (`adminGuard`)
- **Response:** `200 OK`

```json
{
   "success": true,
   "data": {
      "total_balance": "1200000000",
      "per_source_breakdown": [
         { "source": "trading", "balance": "1500000000" }
      ],
      "last_updated": "2026-10-21T10:00:00.000Z"
   }
}
```

### GET /admin/treasury/allocations

Paginated `FundsAllocated` history (`destination`, `amount`, `purpose`, `tx_hash`,
`ledger`, `occurred_at`).

- **Auth:** Admin JWT
- **Query:** `page` (default `1`), `limit` (default `20`, max `100`)

### GET /admin/treasury/inflows

Paginated `FeeReceived` history (`source`, `amount`, `tx_hash`, `ledger`,
`occurred_at`).

- **Auth:** Admin JWT
- **Query:** `page` (default `1`), `limit` (default `20`, max `100`)

---

## Keys Endpoints

### GET /keys/:keyId/leaderboard

Returns wallets ranked by the selected `LeaderboardUpdated` metric. Results
are cached for 60 seconds and the cache is invalidated when a new event is
indexed for the key. Keys without indexed leaderboard rows return an empty
`items` array.

- **Auth:** None
- **Query Params:** `metric` (`volume`, `pnl`, or `holding_days`, required),
  `limit` (integer, default `20`, maximum `100`)
- **Response:** `{ "success": true, "data": { "items": [{ "rank": 1, "wallet": "...", "score": "..." }] } }`

### GET /keys/:keyId/leaderboard/:wallet

Returns the wallet's ordinal rank and exact score for each leaderboard metric.
Each metric is `null` when the wallet has no indexed entry for the key.

- **Auth:** None
- **Response:** `{ "success": true, "data": { "keyId": "...", "wallet": "...", "metrics": { "volume": { "rank": 1, "score": "..." }, "pnl": null, "holding_days": null } } }`

### GET /keys/:keyId/price

Returns the current bonding-curve buy and sell price for a given quantity of
keys. Resolves `keyId` by database id **or** handle. All bigint values are
serialised as strings. Response is cached in Redis for 10 seconds.

- **Auth:** None
- **Query Params:**
   - `quantity` (integer, 1–1 000 000, default `1`) — number of keys to price

- **Response:** `200 OK`

```json
{
   "success": true,
   "data": {
      "keyId": "cm_creator_abc",
      "quantity": 5,
      "currentSupply": "100",
      "buy": {
         "unitPrice": "11250000",
         "totalCost": "56250000"
      },
      "sell": {
         "unitPrice": "10750000",
         "totalProceeds": "53750000"
      },
      "priceImpactPercent": "2.27"
   }
}
```

> `sell` is `null` when `quantity` exceeds the current circulating supply.

- **Error Responses:**
   - `400 Bad Request` — `quantity` is missing, non-integer, ≤ 0, or > 1 000 000
   - `404 Not Found` — key does not exist

### Community Polls

Polls are indexed from `PollCreated`, `PollVoteCast`, and `PollClosed` contract
events. Results report vote counts and summed vote weight per option. Responses
are cached for 30 seconds and invalidated when a poll event for the key is
indexed.

#### GET /keys/:keyId/polls

Lists all active and closed polls for a key with expiry, total votes, total
voting weight, and per-option weight tallies.

#### GET /keys/:keyId/polls/:pollId

Returns poll details and per-option vote counts and weights in `optionResults`.

#### GET /keys/:keyId/polls/:pollId/votes/:wallet

Returns whether the wallet voted and, if so, its selected option and indexed
vote weight. Invalid Stellar wallet addresses return `400`; unknown keys or
polls return `404`.

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

## Dividend Snapshot Endpoints

### GET /keys/:keyId/dividends

List dividend snapshots for a key, newest first. Use `limit` (1–100, default 50) and the returned `pagination.nextCursor` to request the next page.

Each entry includes `totalDistributed`, `claimWindowStart`, and
`claimWindowEnd`. The legacy `totalAmount` and `distributionId` fields are
retained for compatibility.

### GET /keys/:keyId/dividends/:wallet

Return the wallet's dividend amounts for every snapshot of the key. Each
snapshot includes `claimableAmount`, `claimedAmount`, and the claim window.
`claimableAmount` is the wallet's unclaimed amount; the claim-window fields
indicate when the on-chain claim is available.

- **Auth:** None
- **Response:** `200 OK`; invalid wallet addresses return `400`, and unknown
  keys return `404`.
