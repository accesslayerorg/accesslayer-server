# Admin Operator Tools: DLQ, Priority Queues, and Impersonation

This page covers the admin endpoints added for the indexer dead-letter queue (#1341), outbox priorities (#1341), and read-only impersonation (#1342). All admin routes live under `/api/v1/admin` and require an admin JWT (`role: "admin"`). Non-admin tokens get `403`.

## Second factor claim

Starting an impersonation session requires a fresh second factor. The server does not run a second-factor challenge itself. The identity provider that issues admin tokens must add an `mfa_at` claim, in epoch seconds, recording when the admin last completed a second-factor challenge. The session can start only if that claim is no more than 5 minutes old.

Without `mfa_at`, or with a stale value, `POST /admin/impersonate` returns `403`.

## Dead-letter queue

Failed indexer jobs are stored in the `IndexerDLQ` table. Outbox events that exhaust their publish attempts are written there too, with `jobType` `outbox:<event type>`.

| Method   | Path                          | Purpose                                                                                                   |
| -------- | ----------------------------- | --------------------------------------------------------------------------------------------------------- |
| `GET`    | `/admin/dlq`                  | List live entries, oldest first. Filters: `queue` (job type), `error` (substring of the failure reason), `cursor`, `limit` (max 100). Also returns per-queue depth and oldest age. |
| `POST`   | `/admin/dlq/:id/replay`       | Replay one entry. `404` if missing, `409` if already replayed.                                            |
| `POST`   | `/admin/dlq/replay`           | Replay up to 500 entries selected by `ids`, or by `queue` / `error`. Requires one of those selectors.      |
| `DELETE` | `/admin/dlq/:id`              | Delete an entry. Body `{ "reason": "..." }` is required, at least 10 characters. The delete and its audit record commit in one transaction. |

Behaviour to know about:

- **Replay runs once.** A successful replay sets `replayedAt`, and that entry is never replayed again. A failed replay leaves the entry live and records `FAILED: <message>` in `lastReplayOutcome`.
- **Concurrent replays are safe.** Each entry is claimed with a compare-and-set on `replayCount` before its handler runs, so two admins cannot run the same handler twice.
- **Replay needs a handler.** The codebase has no generic way to re-run an indexer job, so the owning indexer must register one with `registerDlqReplayHandler(jobType, handler)` in `src/modules/admin/dlq-replay.registry.ts`. Until it does, a replay attempt records `NO_HANDLER` and the entry stays live.

Metrics: `GET /api/v1/metrics/queues` reports one entry per DLQ job type with `state: "dlq"`, `depth`, and `oldestAgeSeconds`. The values refresh when `syncDLQQueueMetrics()` runs, which no scheduler calls yet, so wire it into a worker before relying on it for alerts.

## Outbox priorities

Outbox events carry a `priority` of `critical`, `normal`, or `bulk`. The type decides the default:

- `critical`: types starting with `settlement`, `order_fill`, or `alert`.
- `bulk`: types starting with `bulk_` or `backfill`.
- `normal`: everything else.

Each poll cycle fetches critical events first and fills the batch with them. Normal events come next. Bulk events are capped at 10 per cycle, so a large bulk backlog cannot starve other work. Events that reach the attempt limit (10) stop being polled and are dead-lettered.

Run one outbox publisher per deployment. Rows are not row-locked.

## Read-only impersonation

Support staff can view what a user sees. The session is read-only and short-lived.

| Method   | Path                    | Body                          | Result                                                        |
| -------- | ----------------------- | ----------------------------- | ------------------------------------------------------------- |
| `POST`   | `/admin/impersonate`    | `{ "walletAddress", "reason" }` | `{ sessionId, token, targetWallet, expiresAt, readOnly: true }` |
| `DELETE` | `/admin/impersonate`    | `{ "sessionId", "reason"? }`  | Ends the session immediately. `404` if unknown, `409` if already ended. |

The returned `token` is a bearer token that authenticates as the target wallet, valid for 15 minutes. The server enforces these rules on every request that carries it:

- Only `GET`, `HEAD`, and `OPTIONS` are allowed. Anything else returns `403`.
- These route groups are never reachable: `/admin`, `/auth`, `/api-keys`, `/export`, `/exports`, `/signing`, `/webhooks`, and `/account`.
- Responses carry `X-Impersonated-By: admin`, so clients can show a banner.
- Each request is written to the audit log with the method, path, and whether it was allowed.
- The session row is checked on every request. Ending it takes effect on the next request, not at token expiry.
- When a session ends, by an admin or by expiry, the target user is emailed. Expiry is detected on the first request made with the expired token, so the email can be delayed until the user or the attacker next uses it. A scheduled sweeper would close that gap and is not included.

Schema: `ImpersonationSession` (`prisma/schema/admin-impersonation.prisma`). Migration: `20261124000500_add_impersonation_sessions`.

## Known gaps

- No 2FA issuance exists in this repository. The `mfa_at` check is in place, but the identity provider has to issue the claim.
- Replay handlers are not registered for any job type yet. Replay is inert until the indexers register them.
- Expiry-driven impersonation notifications wait for the next request, as described above.
