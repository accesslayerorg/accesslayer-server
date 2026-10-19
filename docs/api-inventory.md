# API Route Inventory

This document lists the current HTTP endpoints exposed by the Access Layer Server.

**Base URL:** `/api/v1`

## Health Module

Routes for service availability checks and diagnostics.

| Method | Path               | Description                                                   |
| :----- | :----------------- | :------------------------------------------------------------ |
| `GET`  | `/health`          | Simple liveness check for load balancers and uptime monitors. |
| `GET`  | `/health/ready`    | Readiness check that verifies critical dependencies.          |
| `GET`  | `/health/detailed` | Detailed diagnostics including system and database status.    |

## Auth Module

Authentication and session-related endpoints.

| Method | Path             | Description                                        |
| :----- | :--------------- | :------------------------------------------------- |
| `POST` | `/auth/login`    | Authenticate a user and return a session response. |
| `POST` | `/auth/register` | Register a new user account.                       |

## Config Module

Public bootstrap configuration.

| Method | Path      | Description                                              |
| :----- | :-------- | :------------------------------------------------------- |
| `GET`  | `/config` | Return public protocol configuration for client startup. |

## Creators Module

Public creator discovery and stats endpoints.

- Request lifecycle reference: [`docs/creator-request-lifecycle.md`](./creator-request-lifecycle.md).

| Method | Path                       | Description                                           |
| :----- | :------------------------- | :---------------------------------------------------- |
| `GET`  | `/creators`                | List creators with pagination and filtering.          |
| `GET`  | `/creators/:id/stats`      | Return public stats for a specific creator.           |
| `GET`  | `/creators/:wallet/social` | Return on-chain synced social metadata for a creator. |

## Search Module

Global search across creator keys, creator profiles and transaction hashes (#1010).

- `GET /search` returns grouped overlay results: keys (top 3), creators (top 3) and transactions (top 1).
- Key results match on metadata name, symbol and description.
- Creator results match on display name and wallet-address prefix.
- Transaction results require an exact tx-hash match.
- The full-results endpoints use signed keyset cursors ordered by match relevance.

| Method | Path               | Description                                    |
| :----- | :----------------- | :--------------------------------------------- |
| `GET`  | `/search?q=`       | Grouped results for the client search overlay. |
| `GET`  | `/search/keys`     | Cursor-paginated full key search results.      |
| `GET`  | `/search/creators` | Cursor-paginated full creator search results.  |

## Webhooks Module

Manage trade webhooks for creator profiles.

- Trade webhooks reference (payload shape, retry behavior, delivery guarantees): [`docs/webhooks.md`](./webhooks.md).

| Method   | Path                                | Description                                   |
| :------- | :---------------------------------- | :-------------------------------------------- |
| `POST`   | `/creators/:id/webhooks`            | Register a new webhook for trade events.      |
| `GET`    | `/creators/:id/webhooks`            | List all registered webhooks for the creator. |
| `DELETE` | `/creators/:id/webhooks/:webhookId` | Delete a registered webhook.                  |

## Activity Module

Public activity feed endpoints.

| Method | Path        | Description                      |
| :----- | :---------- | :------------------------------- |
| `GET`  | `/activity` | Return the public activity feed. |

## Wallets Module

Wallet activity and trade history endpoints.

| Method | Path                         | Description                                                   |
| :----- | :--------------------------- | :------------------------------------------------------------ |
| `GET`  | `/wallets/:address/activity` | Return paginated trade history (buys and sells) for a wallet. |

## Referrals Module

Wallet-scoped referral reward earnings indexed from `ReferralRewardDistributed`
events.

- Referral earnings reference: [`docs/referral-earnings.md`](./referral-earnings.md).

| Method | Path                          | Description                                                      |
| :----- | :---------------------------- | :--------------------------------------------------------------- |
| `GET`  | `/referrals/:wallet/earnings` | Paginated referral earnings history with an optional date range. |
| `GET`  | `/referrals/:wallet/summary`  | Total earnings, tier 1/2/3 breakdown, and referred wallet count. |

## Ownership Module

Ownership lookup endpoints.

| Method | Path         | Description                                           |
| :----- | :----------- | :---------------------------------------------------- |
| `GET`  | `/ownership` | Look up key ownership by owner address or creator ID. |

## Contracts Module

Centralised Soroban contract interaction service (#899).

- Service reference (retry, error classification, tracking, events): [`docs/soroban-contract-service.md`](./soroban-contract-service.md).

| Method | Path              | Description                                                            |
| :----- | :---------------- | :--------------------------------------------------------------------- |
| `POST` | `/contracts/call` | Submit a signed contract transaction through the centralised pipeline. |

## Metrics Module

Operational metrics for background work.

| Method | Path              | Description                                   |
| :----- | :---------------- | :-------------------------------------------- |
| `GET`  | `/metrics/queues` | Return queue depth metrics for worker queues. |

## Admin Module

Restricted administrative endpoints.

| Method  | Path                           | Description                                         |
| :------ | :----------------------------- | :-------------------------------------------------- |
| `PATCH` | `/admin/creators/:id/metadata` | Update creator metadata such as verification state. |
| `POST`  | `/admin/indexer/replay`        | Trigger an indexer replay job.                      |
| `GET`   | `/admin/flash-loan-violations` | Flash loan violations by wallet frequency (#938).   |

## Staking Module

Staking reward multiplier tiers and position calculations (#942).

| Method | Path                                      | Description                                                                               |
| :----- | :---------------------------------------- | :---------------------------------------------------------------------------------------- |
| `GET`  | `/staking/multiplier-tiers`               | Return all staking reward multiplier tiers with lock periods and multipliers (cached 5m). |
| `GET`  | `/staking/positions/:id/effective-weight` | Return the weighted stake calculation for a specific position.                            |
| `GET`  | `/staking/positions/:id`                  | Return a single staking position with embedded tier data and effective weight.            |
| `GET`  | `/staking/positions`                      | List staking positions with embedded tier data.                                           |

## Governance Module

Snapshot governance proposals (#878). Voting weight is the voter's staked
balance frozen at the proposal's snapshot block, so keys moved after creation
cannot change a vote's weight. Quorum is checked when the proposal closes and
the status transitions `active` → `passed` / `failed` / `quorum_not_met`.

| Method | Path                               | Description                                                                                  |
| :----- | :--------------------------------- | :------------------------------------------------------------------------------------------- |
| `GET`  | `/governance/proposals`            | List proposals with vote tallies and status (filter by `status`, `keyId`; cursor-paginated). |
| `POST` | `/governance/proposals`            | Create a proposal and freeze snapshot voting weights (requires the key creator's JWT).       |
| `POST` | `/governance/proposals/:id/vote`   | Cast a vote weighted by the wallet's snapshot staked balance (requires JWT).                 |
| `GET`  | `/governance/proposals/escalating` | List proposals currently in quorum escalation (#935).                                        |

## Traders Module

Volume fee discount tiers and trader 30-day rolling volume lookups (#1030).

| Method | Path                        | Description                                                                                              |
| :----- | :-------------------------- | :------------------------------------------------------------------------------------------------------- |
| `GET`  | `/traders/:wallet/discount` | Return current volume discount tier, discount bps, and 30-day rolling volume for any wallet (cached 5m). |

---

## Root and Miscellaneous

Endpoints outside the `/api/v1` namespace.

| Method | Path          | Description                                      |
| :----- | :------------ | :----------------------------------------------- |
| `GET`  | `/`           | Redirect to `/api-docs`.                         |
| `GET`  | `/api-docs`   | Interactive API documentation.                   |
| `GET`  | `/test-email` | Diagnostic endpoint for testing email transport. |
