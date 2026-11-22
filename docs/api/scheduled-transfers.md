# Scheduled key transfers

`GET /api/v1/wallets/:address/scheduled-transfers` returns scheduled transfers
for a Stellar account. Query parameters:

- `direction`: `incoming`, `outgoing` or `all` (default).
- `limit`: integer from 1 to 100, default 25.
- `cursor`: the previous page's opaque `meta.nextCursor`. Keep the wallet and
  direction unchanged when following it.

The success envelope contains `data.items`, `data.meta` and
`data.currentLedger`. Transfers have `id`, `sender`, `recipient`, `keyId`,
`amount` (integer units as an exact decimal string), `releaseLedger`,
`status`, `claimable`, `estimatedReleaseTime`, `scheduledAt` and
`completedAt`. Pages are ordered by scheduling ledger and transfer ID,
both descending. Claimed and cancelled rows remain available as history;
neither is claimable.

`claimable` is true only for pending transfers at or after their release
ledger. The endpoint reads the latest Horizon ledger for each request rather
than substituting elapsed wall time or the indexer's last processed ledger.
The estimated ISO release time uses the close-time interval between the
latest two network ledgers; it is an estimate, and is null when no interval
is available (for example, the first ledger).

The indexer consumes normalized events supplied by the chain indexing worker.
The protocol adapter must provide the actual caller/chain field naming and a
protocol-unique transfer ID; no source-contract CUID mapping is inferred here.
The indexer accepts `transfer_scheduled`, `transfer_claimed`,
`transfer_cancelled` and their uppercase/PascalCase aliases. Event bodies
may be top-level fields or `payload`; they carry `transferId`
(`transfer_id` or `id`), and scheduling carries `sender`, `recipient`,
`keyId`, positive integer `amount`, and `releaseLedger`. Transfer IDs must be protocol-unique. Nonempty opaque string IDs are preserved
(up to 256 characters). All-digit strings, bigint and safe integer numbers are
normalized to exact decimal u64 strings, so numeric aliases identify one transfer.
Unsafe numeric values, negative numbers and numeric IDs exceeding u64 are rejected.
Key IDs remain the caller's canonical profile/address string.
`key_id` and `release_ledger` are accepted. Chain position stays at the
event envelope: `txHash`, `eventIndex`, `ledger`, and optional
`timestamp`/`ledgerClosedAt`.

A transaction-scoped lock serializes updates for one transfer. The event
journal's unique transaction/event position makes replay a no-op. Terminal
events are retained even if received before the schedule; late scheduling
never resets a claimed or cancelled record. Malformed events go to the
indexer DLQ, and database failures propagate for batch redelivery.

Database/HTTP regression coverage is in
`scheduled-transfer.integration.test.ts`; enable it with
`RUN_SCHEDULED_TRANSFER_INTEGRATION=1` against a disposable migrated database.
