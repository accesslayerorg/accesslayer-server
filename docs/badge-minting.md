# Key NFT Badge Minting Trigger Service

Reference for the automatic badge award pipeline (#1148).

The service watches for qualifying on-chain activity and mints the matching key
NFT badge for the wallet. All minting is routed through the centralised
[Soroban Contract Service](./soroban-contract-service.md) so submission retries,
transaction tracking, and resolution events apply uniformly.

## Badges and triggers

| Badge              | Qualifying event (`triggerEvent`) | Rule                                                 |
| ------------------ | --------------------------------- | ---------------------------------------------------- |
| `FIRST_BUYER`      | `first_swap`                      | The wallet's first swap.                             |
| `WHALE_HOLDER`     | `whale_swap`                      | A single swap ≥ `BADGE_WHALE_THRESHOLD_XLM`.         |
| `GOVERNANCE_VOTER` | `vote_cast`                       | The wallet cast a governance vote.                   |
| `DIAMOND_HANDS`    | `hold_milestone`                  | Continuous hold ≥ `BADGE_HOLD_MILESTONE_DAYS` (365). |
| `TOP_TRADER`       | `leaderboard_entry`               | Leaderboard rank ≤ `BADGE_TOP_TRADER_MAX_RANK` (10). |

A single swap can earn both `FIRST_BUYER` and `WHALE_HOLDER`.

## Components

| File                                                  | Responsibility                                                 |
| ----------------------------------------------------- | -------------------------------------------------------------- |
| `src/modules/badges/badge-trigger.service.ts`         | `evaluateEvent` (pure rules) + `processQualifyingEvent`.       |
| `src/modules/badges/badge-mint.service.ts`            | `mintBadge`: dedup guard → mint w/ retry → audit log.          |
| `src/modules/badges/badge-mint.client.ts`             | Default client: submits `mint_badge` via the contract service. |
| `src/modules/badges/badge-mint.builder.ts`            | Builds + signs the `mint_badge(wallet, badge_type)` envelope.  |
| `src/modules/badges/badge.constants.ts`               | Thresholds (whale/hold/rank) and attempt limits.               |
| `src/modules/badges/badge.types.ts`                   | Badge types, event shapes, client/result interfaces.           |
| `src/modules/indexer/badge-minted-indexer.service.ts` | Indexes confirmed `BadgeMinted` events into `wallet_badges`.   |
| `src/modules/badges/badge-read.service.ts`            | Wallet badge collection/summary with five-minute cache.        |
| `prisma/schema/badge-mint.prisma`                     | `BadgeMintLog` audit table.                                    |

## Flow

```
processQualifyingEvent(event)
        │
        ▼
evaluateEvent(event) ──► [] no badges earned ──► done
        │
        ▼ one or more BadgeAward
mintBadge(wallet, badgeType, triggerEvent)
        │
        ├─ 1. Dedup: badge already MINTED for (wallet, badgeType)? ─► SKIPPED
        │
        ├─ 2. Mint via contract client
        │        transient failure ─► retry up to BADGE_MINT_MAX_ATTEMPTS
        │        user failure      ─► terminal, no retry
        │
        └─ 3. Upsert badge_mint_log (MINTED | FAILED), attempts + error recorded
```

## Deduplication

`badge_mint_log` has a unique `(wallet, badgeType)` constraint — one row per
award. `mintBadge` short-circuits to `SKIPPED` when a row is already `MINTED`, so
re-processing the same (or an overlapping) event never re-mints. A row left
`FAILED` by an exhausted retry is eligible to be re-attempted on the next event.

## Retry

Minting inherits the contract service's submission retries; on top of that,
`mintBadge` retries the whole mint on **transient** outcomes (RPC down,
timeouts, unconfirmed) up to `BADGE_MINT_MAX_ATTEMPTS` with a linear backoff.
**User** outcomes (e.g. `unauthorized`, `reverted`) are terminal and not
retried. The final attempt count and last error are persisted on the log row.

## Integration

Indexer / webhook consumers call `processQualifyingEvent` as activity is
observed:

```ts
import { processQualifyingEvent } from '../modules/badges';

// On an observed swap:
await processQualifyingEvent({
   kind: 'swap',
   wallet,
   amount,
   isFirstSwap,
   txHash,
});

// On a governance vote:
await processQualifyingEvent({ kind: 'vote', wallet, proposalId, txHash });
```

Confirmed `BadgeMinted` events are independently indexed into `wallet_badges`
by the shared indexer pipeline. The cursor advances only after this projection
is persisted. Wallet badge reads are available at:

- `GET /api/v1/wallets/:wallet/badges` — earned badges and the remaining locked
  badge types, with mint timestamps for earned badges.
- `GET /api/v1/wallets/:wallet/badges/summary` — total earned and a count for
  each of the five badge types.

Both read responses are cached for five minutes. A newly indexed badge mint
invalidates both cached responses for that wallet.

## Configuration

| Variable                    | Default | Description                                                 |
| --------------------------- | ------- | ----------------------------------------------------------- |
| `BADGE_CONTRACT_ID`         | —       | Deployed badge contract id. Minting is disabled unless set. |
| `BADGE_MINTER_SECRET`       | —       | Server keypair secret that signs mints. Required to mint.   |
| `BADGE_WHALE_THRESHOLD_XLM` | `10000` | Single-swap size that earns `WHALE_HOLDER`.                 |
| `BADGE_HOLD_MILESTONE_DAYS` | `365`   | Hold duration that earns `DIAMOND_HANDS`.                   |
| `BADGE_TOP_TRADER_MAX_RANK` | `10`    | Highest rank that earns `TOP_TRADER`.                       |
| `BADGE_MINT_MAX_ATTEMPTS`   | `3`     | Max mint attempts before a transient failure is terminal.   |
