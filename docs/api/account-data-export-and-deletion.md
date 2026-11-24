# Personal Data Export and Account Deletion

Lets a signed-in user download their personal data and schedule deletion of their account (#1325). Both flows are scoped to the caller's own records.

Account routes need a wallet JWT (`Authorization: Bearer <token>`) for a wallet linked to a user account. Without a linked wallet they return `401`.

## Data export

| Method | Path                                 | Purpose                                                   |
| ------ | ------------------------------------ | --------------------------------------------------------- |
| `POST` | `/v1/me/data-export`                 | Queue an export. `202` with the job. `409` if one is already queued or running. |
| `GET`  | `/v1/me/data-export/:id`             | Status of one of your exports, with `downloadUrl` once ready. |
| `GET`  | `/v1/me/data-export/:id/download`    | The archive as a JSON attachment. Authorised by the `expires` and `sig` query parameters, not a session. |

### Archive contents

- `account`: user id, email, names, phone, email verification state, creation time. The password hash is never included.
- `wallet`: the linked Stellar address and when it was linked.
- `creatorProfiles`: your creator profiles (public profile fields only).
- `creatorPosts`: posts published by your creator profiles.
- `comments`, `orders`: comments and limit orders made from your wallet.
- `preferences.watchlist`, `settings.priceAlerts`, `settings.autoInvestRules`: watchlist entries and alert or auto-invest configuration.

### Download links

Links are valid for 24 hours from completion. They are signed with an HMAC over the job id and its exact expiry, so a link cannot be reused for another export. After the window closes, the archive is discarded and the job reads as `expired`.

Exports are built by the account lifecycle worker, which runs every minute. Only one export may be queued or running per account.

## Account deletion

| Method   | Path             | Purpose                                                              |
| -------- | ---------------- | -------------------------------------------------------------------- |
| `POST`   | `/v1/me/deletion` | Schedule deletion. `201` on success. `409` lists each blocker.       |
| `GET`    | `/v1/me/deletion` | Latest deletion request, or `null`.                                  |
| `DELETE` | `/v1/me/deletion` | Cancel a pending deletion. Allowed only during the grace period.     |

### Grace period and blockers

Deletion is scheduled 14 days after the request. It can be cancelled until then.

A request is refused while any of these exist for the account's wallet:

- `open_orders`: limit orders in `OPEN` or `EXECUTABLE`.
- `active_plans`: scheduled transfers still `pending`, or auto-invest rules that are active.
- `unclaimed_earnings`: LP reward positions with accrued but unclaimed rewards, unclaimed revenue claims, or unclaimed dividends.

The `409` response carries one `details` entry per blocker, with `field` set to the blocker code. If an obligation appears during the grace period, the worker defers anonymization and the request stays cancellable.

### What anonymization does

When the grace period ends, the worker anonymizes the account in one transaction:

- The user's email, names, phone, avatar and password hash are replaced. The account can no longer sign in.
- Creator profiles lose their public text and get a placeholder handle.
- Comments and limit orders from the wallet are re-keyed to the request's `pseudonymId`. Comment bodies are replaced with `[deleted]`.
- Price alerts, watchlist entries and auto-invest rules are deleted.
- The wallet link is removed.

Trade, holding and earnings rows that reference the on-chain address are not rewritten. Stellar addresses are public ledger data, and once unlinked from any account they are pseudonymous. Rewriting them would also break the indexer's reconciliation with chain state.

## Worker

`src/workers/account-lifecycle.worker.ts` runs each minute. Each tick expires old archives, builds queued exports and anonymizes due accounts. Work is claimed with conditional updates, so multiple instances do not process the same job.
