# Invoice protocol APIs and worker adapter

This module adds issuer reputation, fraud reports, transfer restrictions, and timelock read models. Creator-key reputation remains a separate domain. All URLs below are under `/api/v1` and use the standard `success`, `data`, and error envelopes.

## Configuration and contract compatibility

Configure `ISSUER_REPUTATION_CONTRACT_ID`, `INVOICE_TRANSFER_CONTRACT_ID`, `INVOICE_FRAUD_CONTRACT_ID`, and `INVOICE_TIMELOCK_CONTRACT_ID` for the deployed contracts. Each event must match its configured contract. Read simulations use the existing `STELLAR_SOROBAN_RPC_URL`, network setting, and transport timeout. No view call is signed or broadcast. A missing contract, transport error, simulation error, or malformed result returns `503`; it never implies that a transfer is allowed.

The required view ABI is:

- `get_issuer_score(wallet: Address)` returns a map with `score` (nonnegative integer) and `tier` (string).
- `check_transfer(from: Address, to: Address, invoice_id: u64)` returns a map with `allowed: bool`. A blocked result must also contain string `reason` and `restriction_type`. Boolean `true` is accepted as an allowed result; a bare `false` lacks the required diagnostic information and is rejected.

**No deployed invoice purchase ABI was available to verify.** The server therefore has no default purchase function or argument mapping. Before enabling purchases, a maintainer must configure `INVOICE_MARKET_CONTRACT_ID` and `INVOICE_MARKET_ABI` from the actual deployed ABI. The JSON mapping contains `function`, `from`, `to`, `invoice`, and optionally `limitPrice`; the numeric values are distinct zero-based argument indexes.

Illustrative configuration only, **not a verified deployment**:

```dotenv
INVOICE_MARKET_ABI={"function":"purchase","from":0,"to":1,"invoice":2,"limitPrice":3}
```

The mapped wallets must be ScVal addresses, invoice must be u64, and optional limit must be a positive i64/u64/i128/u128 integer. The deployed function must enforce `limitPrice` as a maximum purchase price in its own units. Configure that index only after verifying this semantic guarantee. Limit-order creation is disabled without it. Signed envelopes must have one operation, use the buyer as source and recipient, target the configured contract/function, and agree with the stored invoice's seller. The server never modifies or re-signs envelopes. Stellar validates the signatures and final contract authorization on submission.

The central `/contracts/call` service applies the same guard based on the signed operation, regardless of the caller's `operation` label. Unrecognized calls to the configured invoice market are rejected; this endpoint is not a general administration bypass for that market. Other contracts retain their existing submission behavior. Operationally, configure the market address whenever its submissions are accepted; an unconfigured address cannot be recognized by the generic contract service.

## HTTP endpoints

| Method and path                                 | Result                                                                              |
| ----------------------------------------------- | ----------------------------------------------------------------------------------- |
| `GET /issuers/:wallet/reputation`               | On-chain `score`, `tier`, indexed `history_count`, `last_updated`                   |
| `GET /issuers/:wallet/reputation/history`       | Indexed changes with score, tier, `event_type`, `timestamp`, transaction hash/index |
| `GET /invoices/:invoice_id`                     | Invoice detail including `under_review` while any report is `OPEN`                  |
| `GET /invoices/:invoice_id/reports`             | Reports with status, evidence hash, notes, resolution and timestamps                |
| `GET /invoices/:invoice_id/reports/:report_id`  | Report scoped to the invoice; a different invoice gets `404`                        |
| `GET /invoices/:invoice_id/transfer-audit`      | Indexed `TransferBlocked` history with reason and restriction type                  |
| `GET /governance/timelock/pending`              | Pending proposals with target, function, params, ETA and countdown                  |
| `GET /governance/timelock/history`              | Executed/cancelled proposals and outcomes                                           |
| `GET /governance/timelock/:proposal_id`         | Full proposal detail                                                                |
| `POST /invoices/:invoice_id/buy`                | Submit the caller's signed purchase after transfer restriction check                |
| `POST /invoices/:invoice_id/limit-orders`       | Store a signed purchase envelope with an immutable price bound                      |
| `POST /invoices/:invoice_id/limit-orders/match` | Attempt eligible stored envelopes; skip restricted pairs                            |

Lists accept `page` (default 1) and `limit` (default 20, maximum 100) and return the standard `meta` pagination object. Missing issuer score records, invoices, reports, or proposals return `404`. `GET /invoices/compare` keeps its existing route and response.

Write routes require a wallet JWT. Buy/order creation accepts only `{ "transaction_xdr": "..." }`; no unsigned wallet or price fields can override the signed arguments. A buyer may trigger their own orders; the invoice seller may trigger all orders for that invoice. Each call scans pending or interrupted orders in creation order using 100-row keyset pages and a request-start cutoff. Skipped orders do not starve eligible orders on later pages; newly created orders wait for the next call. This is a queue of pre-authorized purchase candidates, not an off-chain price oracle: the contract enforces the signed limit. Restricted orders remain pending and return `SKIPPED`, with `reason` and `restriction_type`. Eligible orders use the central submission/confirmation service. A durable lease prevents concurrent claims; an interrupted or unconfirmed attempt reuses the exact signed envelope and transaction hash after lease expiry. Confirmed orders become `FILLED`; chain failures become `FAILED`. Expired signatures/time bounds require a newly authorized envelope.

A blocked buy returns HTTP 403 with `error.code: "TransferBlocked"`, the reason in `error.message`, and standard `error.details` entries named `reason` and `restriction_type`. Transport failures return 503. Restriction decisions are cached for 60 seconds using the exact ordered wallet pair, invoice, network, and contract. As with any preflight cache, the contract must enforce restrictions again during execution.

Reputation views cache score/tier for 60 seconds in Redis. Keys include the indexed event generation, preventing a racing old read from populating the new generation. Indexing a score event invalidates the affected wallet's old key. Redis unavailability disables caching while preserving authoritative reads. Timelock countdowns are computed per request, clamp to zero, and carry `Cache-Control: no-store`.

## Event ingestion and replay

The repository's external worker architecture is unchanged. Workers can deliver normalized events through `processIndexerEvents`, or use `processInvoiceProtocolRpcPage` for `getEvents` pages filtered to the four invoice read/event contracts. The adapter decodes XDR ScVal topics and map values, dispatches all recognized events, then stores the **opaque RPC cursor** in `invoice_protocol_cursor`. This cursor is separate from the trade worker's checkpoint because the streams have different filters. A partially filled ledger must resume with its RPC cursor, not `ledger + 1`. Empty pages must retain the cursor supplied by RPC. Serialize page processing for each stream; do not launch pages concurrently.

`processInvoiceProtocolRpcPage` takes `{ events, cursor, latestLedger }`; event fields match Soroban RPC (`id`, `contractId`, `txHash`, `ledger`, `ledgerClosedAt`, XDR `topic[]`, XDR `value`, optional `inSuccessfulContractCall`). Failed-contract-call events are ignored. A known malformed event or database error rejects the page without advancing its checkpoint. Database writes that preceded the error are safe to replay.

Normalized events require `contractId`, `txHash`, `ledger`, `transactionIndex`, `eventIndex`, `timestamp`, `eventType`, and `payload`. Explicit transaction order is required rather than guessed from a hash. The decoder extracts it from the Soroban TOID in the RPC event ID. Event names can use the specified CamelCase names or their SCREAMING_SNAKE_CASE equivalents. The first topic is the event name and the value is a map with these fields:

| Event                                | Payload fields                                                           |
| ------------------------------------ | ------------------------------------------------------------------------ |
| `IssuerScoreUpdated`                 | `wallet`, `score`, `tier`                                                |
| `ReportSubmitted`                    | `report_id`, `invoice_id`, `reporter`, `evidence_hash`, optional `notes` |
| `ReportResolved`                     | `report_id`, `invoice_id`, `resolution`, optional `resolution_notes`     |
| `ChangeProposed`                     | `proposal_id`, `target`, `function`, `params`, `eta`                     |
| `ChangeExecuted` / `ChangeCancelled` | `proposal_id`, optional `outcome`                                        |
| `TransferBlocked`                    | `invoice_id`, `from`, `to`, `reason`, `restriction_type`                 |

IDs are u64 decimal strings or equivalent numeric ScVals; keep invoice database IDs aligned with their on-chain IDs. Timestamps/ETA accept Unix seconds or ISO strings. JSON parameters preserve large integers as decimal strings and byte strings as hex. If the deployed event layout differs, adapt the external worker to this documented normalized shape rather than silently dropping fields.

The immutable journal has a unique `(contractId, txHash, eventIndex)` identity. A PostgreSQL advisory lock serializes projection changes per entity. Projections are rebuilt from the latest relevant journal events in ledger/transaction/event order. Resolution/completion arriving before submission/proposal remains in the journal and is applied when the earlier event arrives. This supports duplicate deliveries, crash retries, and out-of-order backfills without reverting final states or losing historical changes. Report identities are scoped by invoice, so equal report IDs on different invoices do not collide. Workers must include the invoice ID when normalizing both report events. Fraud reports do not require an invoice foreign key, since event indexing can precede invoice ingestion.

## Verification

Apply `20261019000000_add_invoice_protocol_projections`, then regenerate Prisma. Against a disposable PostgreSQL database:

```sh
RUN_INVOICE_PROTOCOL_INTEGRATION=1 DATABASE_URL=postgresql://... pnpm test --runInBand --testPathPatterns=invoice-protocol
pnpm build
pnpm lint
```

The PostgreSQL suite is opt-in for local default runs (`RUN_INVOICE_PROTOCOL_INTEGRATION=1`) and runs in a dedicated CI job with PostgreSQL. The integration suite explicitly unmocks Prisma, seeds and removes fixtures, and calls the real Express app through Supertest. It stubs only external RPC/cache facilities; no live chain transaction is submitted. It verifies concurrent replay, RPC decoding/checkpoint failure, all read endpoints, 404s, score and restriction cache expiry, signed-envelope validation, guarded generic submissions, durable order matching and audit history. Deployment ABI compatibility still requires maintainer verification as described above.
