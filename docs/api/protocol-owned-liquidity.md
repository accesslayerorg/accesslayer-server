# Protocol-owned liquidity

GET /api/v1/protocol/pol (also /v1/protocol/pol) returns balance, deployedAmount and repaidAmount. Values are exact decimal strings in native contract integer units (stroops for XLM); the current reserve summary has a 30-second Redis TTL and is invalidated after funding, deployment and repayment.

GET /api/v1/keys/:keyId/backstops (also /v1/keys/:keyId/backstops) returns the event history newest ledger first, total applied/repaid, outstandingAmount=applied-repaid and repaymentStatus (none, outstanding, partial, repaid). It accepts limit1–100(default25) and offset0–1000000(default0). The ledger history includes both deployments and repayments; repayment status describes the key's aggregate backstop.

Normalized ingestion calls processIndexerEvents with pol_funded, backstop_applied or backstop_repaid (PascalCase and UPPER_CASE aliases supported), positive i128 amount, txHash, eventIndex and ledger. Backstop events also carry keyId/key_id/creatorId/creator; optional timestamp is an ISO date or Unix seconds number. The projection retains signed deltas even when events arrive before funding, so replays and interleaved batches converge without clipping balances. Durable (txHash,eventIndex) receipts and reserve changes commit in one transaction.

The server has no general Soroban polling adapter. An ingestion client must decode events and invoke the normalized mixed-event pipeline; adding read models does not deploy contracts or start chain polling. The existing trade-only reorg handler is unchanged.

POL unit and PostgreSQL/HTTP regressions are selected by the community-state CI job. RUN_POL_INTEGRATION=1 enables the database suite in a disposable test database.
