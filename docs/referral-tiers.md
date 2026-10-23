# Referral Tiers

Referral tiers reward referrers whose referrals drive increasing volume. Tier
state is indexed from the on-chain `ReferralTierUpgraded` event and exposed
through two wallet-scoped REST endpoints. Implementation lives in
`src/modules/referrals/` (API) and
`src/modules/indexer/referral-tier-indexer.service.ts` (indexer).

## Tier ladder

Tiers are defined in `src/modules/referrals/referral-tier.constants.ts`. A
wallet's tier is a function of the cumulative volume of referrals it has
driven; the reward rate (basis points) is applied to referred volume.

| Tier | Minimum cumulative volume (XLM) | Reward rate    |
| :--- | :------------------------------ | :------------- |
| 1    | 0                               | 500 bps (5%)   |
| 2    | 1,000                           | 750 bps (7.5%) |
| 3    | 10,000                          | 1000 bps (10%) |

Tier 1 is the entry tier, so every wallet always has a tier. Once a wallet is
at the top tier, `nextThreshold` and `distanceToNextThreshold` are `null`.

## Data model

Tier state is stored in two tables (`prisma/schema/referral.prisma`):

### `referral_tiers` (`ReferralTier`)

Current tier per wallet — one row per referrer.

| Field              | Type            | Notes                                 |
| :----------------- | :-------------- | :------------------------------------ |
| `walletAddress`    | `String`        | Unique referrer wallet.               |
| `tier`             | `Int`           | Highest tier reached (1, 2 or 3).     |
| `cumulativeVolume` | `Decimal(20,7)` | Cumulative referred volume in XLM.    |
| `lastUpgradedAt`   | `DateTime?`     | Timestamp of the most recent upgrade. |
| `updatedAt`        | `DateTime`      | Last mutation time.                   |

### `referral_tier_events` (`ReferralTierEvent`)

Append-only upgrade log — one row per `ReferralTierUpgraded` event.

| Field              | Type            | Notes                               |
| :----------------- | :-------------- | :---------------------------------- |
| `walletAddress`    | `String`        | Referrer that upgraded.             |
| `previousTier`     | `Int`           | Tier before the upgrade.            |
| `newTier`          | `Int`           | Tier after the upgrade.             |
| `cumulativeVolume` | `Decimal(20,7)` | Volume at the time of the upgrade.  |
| `txHash`           | `String`        | Transaction hash.                   |
| `eventIndex`       | `Int`           | Event index within the transaction. |
| `ledger`           | `Int`           | Ledger the event was observed in.   |
| `occurredAt`       | `DateTime`      | On-chain event timestamp.           |

`(txHash, eventIndex)` is unique, so replaying the same chain event never
records a duplicate upgrade.

## Indexer

`processReferralTierUpgradedEvents(events)` accepts a batch of chain events
and, for each `REFERRAL_TIER_UPGRADED` event:

1. Validates required fields (`walletAddress`, `previousTier`, `newTier`,
   `cumulativeVolume`, `upgradedAt`, `ledger`). Malformed events are skipped
   with a warn-level log.
2. Rejects unconfigured tiers, no-op/downward transitions, negative volumes
   and invalid timestamps.
3. Upserts a `ReferralTierEvent` row keyed on `(txHash, eventIndex)` and
   advances the wallet's `ReferralTier` state. The state only ever moves
   forward (max tier / max volume), so out-of-order replays cannot downgrade a
   wallet.
4. Invalidates the wallet's cached tier snapshot.
5. Checkpoints the highest processed ledger for gap detection.

Duplicates within a batch are removed up front by `processIndexerChainEvents`.

Event shape:

```ts
interface ReferralTierUpgradedEvent {
   eventType: 'REFERRAL_TIER_UPGRADED';
   walletAddress: string;
   previousTier: number; // 0 for a wallet's first tier
   newTier: number; // 1 | 2 | 3
   cumulativeVolume: string; // XLM, string for precision
   upgradedAt: string; // ISO timestamp
   ledger: number;
   txHash: string;
   eventIndex: number;
}
```

## Endpoints

Both endpoints take the wallet as a `wallet` query parameter and require a JWT
(`Authorization: Bearer <token>`) whose wallet claim matches it. A mismatch
returns `401`.

### GET `/api/v1/referrals/tier?wallet=`

Current tier and the metadata needed to render progress towards the next tier.
Cached in Redis for 5 minutes per wallet (invalidated when an upgrade lands).

| Query param | Type   | Notes                              |
| :---------- | :----- | :--------------------------------- |
| `wallet`    | string | Required. Referrer wallet address. |

```json
{
   "success": true,
   "data": {
      "wallet": "GREFERRER...",
      "tier": 2,
      "cumulativeVolume": 1500,
      "nextThreshold": 10000,
      "distanceToNextThreshold": 8500,
      "rewardRateBps": 750,
      "updatedAt": "2026-09-02T00:00:00.000Z"
   }
}
```

### GET `/api/v1/referrals/tier/history?wallet=&limit=&cursor=`

Cursor-paginated upgrade log, newest first.

| Query param | Type    | Default | Notes                                 |
| :---------- | :------ | :------ | :------------------------------------ |
| `wallet`    | string  | –       | Required. Referrer wallet address.    |
| `limit`     | integer | `20`    | 1–100.                                |
| `cursor`    | string  | –       | Opaque cursor from the previous page. |

```json
{
   "success": true,
   "data": {
      "items": [
         {
            "id": "ckxyz",
            "previousTier": 1,
            "newTier": 2,
            "cumulativeVolume": 1500,
            "occurredAt": "2026-09-02T00:00:00.000Z",
            "txHash": "abc123"
         }
      ],
      "pagination": { "limit": 20, "hasMore": false }
   }
}
```

## Referral stats response

`GET /api/v1/users/:wallet/referrals` includes the same `tier` object alongside
the aggregated `totalEarned` / `referralCount` summary and the paginated
breakdown.

```json
{
   "success": true,
   "data": {
      "totalEarned": 12.5,
      "referralCount": 3,
      "tier": {
         "tier": 2,
         "cumulativeVolume": 1500,
         "nextThreshold": 10000,
         "distanceToNextThreshold": 8500,
         "rewardRateBps": 750
      },
      "breakdown": [],
      "pagination": { "limit": 20, "hasMore": false }
   }
}
```
