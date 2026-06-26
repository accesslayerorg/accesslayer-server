# Ownership Read Model

The `key_ownership` table is the source of truth for wallet holdings and holder lists in Access Layer. It is a denormalized read model maintained by the indexer on every trade event.

## Table schema

| Column         | Type        | Description |
| -------------- | ----------- | ----------- |
| `id`           | `String`    | Primary key (CUID). |
| `ownerAddress` | `String`    | Stellar wallet address of the token holder. |
| `creatorId`    | `String`    | References `creator_profiles.id`. Identifies which creator's tokens are held. |
| `balance`      | `Int`       | Number of creator tokens currently held by this wallet. Always ≥ 0. |
| `updatedAt`    | `DateTime`  | Timestamp of the last write, set automatically on each upsert. |

The combination `(ownerAddress, creatorId)` is a unique index — there is exactly one row per wallet/creator pair.

## When the model is updated

The indexer calls `updateOwnership` after processing each confirmed trade event:

- **Buy**: the buyer's `balance` is incremented by the number of tokens purchased.
- **Sell**: the seller's `balance` is decremented by the number of tokens sold.
- **Peer-to-peer transfer**: the sender's `balance` is decremented and the recipient's `balance` is incremented by the transfer amount. Both upserts are applied in the same logical operation.

Rows are created on first acquisition and persist after a full sell (balance reaches zero). A zero-balance row is valid and indicates the wallet previously held tokens.

## Balance conservation invariant

For any given creator, the sum of `balance` across all rows with that `creatorId` must equal the creator's total circulating supply at all times:

```
SUM(key_ownership.balance WHERE creatorId = X) = creator_profiles.totalSupply WHERE id = X
```

The indexer enforces this invariant by applying increments and decrements through Prisma's atomic `{ increment }` / `{ decrement }` operations. No row is overwritten with an absolute value derived from off-chain computation, which eliminates the class of race conditions that would arise from a read-modify-write cycle.

## Replay consistency

If the indexer misses one or more trade events (e.g. due to a crash or a ledger gap), the read model will be inconsistent with the on-chain state.

Consistency is restored by **replaying** the missed ledger range:

1. The gap-detection service (`ledger-gap-detection.service.ts`) identifies missing ledger sequences by comparing the indexed cursor against the chain's latest ledger.
2. The indexer re-fetches and re-processes all events within the gap in sequence order.
3. Because every write uses `upsert` with atomic increments, replaying the same event twice does not corrupt the balance — however, the idempotency guard in `upsertPriceSnapshot` (timestamp comparison) must also be respected for associated price data.
4. After replay, `SUM(balance)` per creator converges back to the expected total supply.

A full rebuild from genesis is possible by truncating `key_ownership` and replaying all events from ledger 0. The `read-model-rebuild.md` document describes the rebuild procedure in detail.

## Related files

- `src/modules/ownership/ownership.service.ts` — `fetchOwnership`, `updateOwnership`
- `src/modules/ownership/ownership.schemas.ts` — Zod schemas for API I/O
- `src/modules/indexer/ledger-gap-detection.service.ts` — gap detection
- `docs/read-model-rebuild.md` — full rebuild procedure
