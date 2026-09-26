# Soroban Contract Interaction Service

Reference for the centralised on-chain submission pipeline (#899).

All contract calls the server submits — buys, sells, stakes, governance
actions, and claims — are routed through one service layer
(`src/modules/contracts`) so retry behavior, error handling, transaction
tracking, and resolution events are applied uniformly instead of being
reimplemented per feature.

## Components

| File                                    | Responsibility                                                        |
| --------------------------------------- | --------------------------------------------------------------------- |
| `src/clients/soroban.client.ts`          | JSON-RPC transport: `sendTransaction` / `getTransaction` with timeout. |
| `src/modules/contracts/contract.service.ts` | Submission pipeline: retry → track → poll → resolve → emit.        |
| `src/modules/contracts/contract-error.utils.ts` | Error classification (`user` vs `transient`) and typed errors. |
| `src/modules/contracts/confirmation-poller.utils.ts` | `getTransaction` polling loop with a deadline.             |
| `src/modules/contracts/contract-events.utils.ts` | `contract_tx_confirmed` / `contract_tx_failed` event emitter.  |
| `src/modules/contracts/contract.schemas.ts` | Zod request validation for the HTTP boundary.                       |
| `src/modules/contracts/contract.controllers.ts` | HTTP controller mapping service errors to status codes.         |
| `src/modules/contracts/contract.routes.ts`  | Route registration (mounted at `/contracts`).                      |

## Submission flow

```
submitContractCall(input, deps)
        │
        ▼
1. Submit signed XDR via Soroban RPC ──► transient error? ──► retry up to
        │                                      │              SOROBAN_SUBMIT_MAX_ATTEMPTS
        │                                      │              with exponential backoff + jitter
        │                                      └── user error? ──► fail immediately (no retry)
        ▼
2. Node returns tx hash ──► INSERT ContractTransaction (status PENDING)
        │
        ▼
3. Poll getTransaction(hash) every SOROBAN_POLL_INTERVAL_MS
        until SUCCESS / FAILED / SOROBAN_POLL_TIMEOUT_MS elapses
        │
        ▼
4. UPDATE row (CONFIRMED | FAILED) + emit
   contract_tx_confirmed | contract_tx_failed event
```

## Error classification

`classifyContractError` splits failures into two kinds:

- **`user`** — retrying cannot change the outcome. Bad/insufficient
  signatures (`tx_bad_auth`), stale sequence (`tx_bad_seq`), insufficient
  balance/fee, malformed envelopes (`tx_malformed`), expired time bounds
  (`tx_too_late`), contract-level rejections (`unauthorized`, `reverted`,
  `insufficient_funds`), and JSON-RPC method-level errors. These return to
  the caller **immediately without retry**.
- **`transient`** — worth retrying. Timeouts, connection resets, HTTP 502 /
  503 / 504, rate limiting, and unrecognised transport failures. These are
  retried up to `SOROBAN_SUBMIT_MAX_ATTEMPTS` (default 3) with exponential
  backoff computed by `computeRetryDelay` (base `SOROBAN_SUBMIT_BASE_DELAY_MS`,
  capped at `SOROBAN_SUBMIT_MAX_DELAY_MS`, plus up to 20% jitter).

XDR/base64 blobs embedded in error messages are sanitized before marker
matching so opaque payload text cannot accidentally flip a classification.

## Transaction tracking

Every accepted submission is persisted in the `ContractTransaction` table
(`prisma/schema/contract-transaction.prisma`) as soon as the node returns a
hash:

- `status = PENDING` with the hash, operation, submitter wallet, and attempt count.
- Updated to `CONFIRMED` (with ledger + result XDR) or `FAILED` (with error
  kind and message) once the poller resolves.
- `txHash` is unique; re-recording the same hash is a no-op warning rather
  than a crash.

Persistence failures never abort the submission flow — they are logged and
the pipeline continues, since the hash and events are the primary contract.

## Resolution events

Downstream consumers subscribe instead of polling the database:

```ts
import { onContractEvent, CONTRACT_EVENTS } from '../modules/contracts';

const unsubscribe = onContractEvent(
   CONTRACT_EVENTS.TX_CONFIRMED,
   payload => {
      // payload: { operation, submitterWallet, txHash, ledger, resultXdr?, attempts }
   }
);

// Later: unsubscribe();
```

`contract_tx_failed` payloads carry `errorKind` (`user` | `transient`) so
handlers can distinguish "the caller did something wrong" from "the RPC was
down". Emission failures are swallowed and logged — events are advisory and
must never break the submission path.

## HTTP API

`POST /api/v1/contracts/call`

```json
{
   "operation": "buy",
   "submitter_wallet": "GABC...",
   "transaction_xdr": "AAAA...base64 signed envelope..."
}
```

Responses:

- `200` — terminal result: `{ "status": "CONFIRMED" | "FAILED", "txHash", ... }`
- `400` — validation error, or user-kind submission failure (no retry happened)
- `503` — transient-kind failure: retries were exhausted (RPC unavailable)

## Configuration

| Variable                      | Default | Description                                     |
| ----------------------------- | ------- | ----------------------------------------------- |
| `SOROBAN_SUBMIT_MAX_ATTEMPTS` | `3`     | Max submission attempts for transient failures. |
| `SOROBAN_SUBMIT_BASE_DELAY_MS`| `1000`  | Exponential backoff base delay.                 |
| `SOROBAN_SUBMIT_MAX_DELAY_MS` | `15000` | Backoff cap.                                    |
| `SOROBAN_POLL_INTERVAL_MS`    | `5000`  | Delay between `getTransaction` polls.           |
| `SOROBAN_POLL_TIMEOUT_MS`     | `120000`| Total polling budget per transaction.           |

All values are optional with schema defaults (see `src/config.schema.ts`).

## Extending

New on-chain operations should:

1. Reuse an existing `ContractOperation` value where possible; add a new one
   to `CONTRACT_OPERATIONS` only if none fits.
2. Build and sign the envelope in the feature module, then call
   `submitContractCall` — never `sendTransaction` directly.
3. Map the returned `ContractSubmissionResult` (or catch
   `ContractSubmitError`) into that module's response shape.
