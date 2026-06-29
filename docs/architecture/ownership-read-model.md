# Ownership Read Model

The ownership read model is the authoritative source of truth for wallet-level key holdings and per-creator holder lists. It is maintained by the indexer and consumed by API endpoints that return holder counts, balances, and holder lists.

## Table Schema

The ownership read model is stored in the `KeyOwnership` table.

| Field          | Type       | Description                                                                 |
|----------------|------------|-----------------------------------------------------------------------------|
| `id`           | `String`   | Unique record identifier (cuid).                                            |
| `ownerAddress` | `String`   | Stellar wallet address of the key holder.                                   |
| `creatorId`    | `String`   | ID of the creator whose keys are held.                                      |
| `balance`      | `Decimal`  | Number of keys currently held. Defaults to `0`. Never goes below `0`.      |
| `createdAt`    | `DateTime` | Timestamp when this ownership record was first created.                     |
| `updatedAt`    | `DateTime` | Timestamp of the most recent balance update (auto-managed by Prisma).       |

**Uniqueness constraint:** `(ownerAddress, creatorId)` — one record per wallet per creator.

**Indexes:** `ownerAddress`, `creatorId` — both indexed for efficient lookups by wallet or by creator.

## Update Triggers

The indexer updates the ownership read model in response to three on-chain trade event types:

### Buy

When a wallet purchases keys from a creator:

1. An `upsert` is performed on `(ownerAddress, creatorId)`.
2. `balance` is incremented by the purchased amount.
3. If no record exists, one is created with `balance = purchased amount`.

### Sell

When a wallet sells keys back to a creator:

1. The existing `KeyOwnership` record for `(ownerAddress, creatorId)` is located.
2. `balance` is decremented by the sold amount.
3. If `balance` reaches `0`, the record is retained at `0` (not deleted) to preserve audit history and simplify replay logic.

### Peer-to-Peer Transfer

When a wallet transfers keys directly to another wallet (without going through the bonding curve):

1. The sender's `KeyOwnership` record is decremented by the transferred amount.
2. The recipient's `KeyOwnership` record is incremented by the same amount (upserted if it does not exist).
3. Both updates are applied atomically where possible to prevent intermediate inconsistent states.

## Balance Conservation Invariant

At any point in time, the sum of all `balance` values across every `KeyOwnership` record for a given `creatorId` must equal that creator's total key supply as recorded on-chain:

```
∑ balance(ownerAddress, creatorId) = creatorTotalSupply(creatorId)
```

This invariant must hold after every trade event is processed. Any discrepancy indicates a missed or double-processed event and should trigger a reconciliation replay.

## Replay and Consistency Recovery

If the indexer misses one or more on-chain events (due to a crash, network gap, or RPC timeout), the ownership read model can fall out of sync with the chain state.

**Replay procedure:**

1. The admin replay endpoint (`POST /api/v1/admin/replay`) re-fetches the affected ledger range from the Stellar RPC and re-emits all trade events in order.
2. Each event is processed with idempotency guards: an event with a ledger sequence already recorded is skipped without modifying the read model.
3. After replay completes, the balance conservation invariant is re-validated. If the sum of balances still does not match the on-chain supply, the replay window is widened and the process repeats.
4. Replay is safe to run at any time because all write paths are idempotent — re-processing a seen event produces no side effects.

Gaps detected by the ledger gap detection service (`LedgerGapDetectionService`) are automatically flagged and can trigger a targeted replay without requiring a full historical re-index.
