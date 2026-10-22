# Referral Earnings

Referral reward earnings are indexed from the on-chain
`ReferralRewardDistributed` contract event and exposed through two
wallet-scoped REST endpoints. Implementation lives in
`src/modules/referrals/` (API) and
`src/modules/indexer/referral-earnings-indexer.service.ts` (indexer).

## Data model

Rewards are stored in the `referral_earnings` table (`ReferralEarning` Prisma
model in `prisma/schema/referral.prisma`):

| Field            | Type            | Notes                                        |
| :--------------- | :-------------- | :------------------------------------------- |
| `id`             | `String`        | `cuid()` primary key.                        |
| `referrerWallet` | `String`        | Wallet that earned the reward.               |
| `sourceWallet`   | `String`        | Referred wallet whose activity generated it. |
| `tier`           | `Int`           | Referral tier: `1`, `2`, or `3`.             |
| `amount`         | `Decimal(20,7)` | Reward amount in XLM.                        |
| `ledger`         | `Int`           | Ledger the event was observed in.            |
| `txHash`         | `String`        | Transaction hash.                            |
| `eventIndex`     | `Int`           | Event index within the transaction.          |
| `earnedAt`       | `DateTime`      | On-chain event timestamp.                    |
| `createdAt`      | `DateTime`      | Row insertion time.                          |

`(txHash, eventIndex)` is unique, so replaying the same chain event is
idempotent and never double-counts earnings.

## Indexer

`processReferralRewardDistributedEvents(events)` accepts a batch of chain
events and, for each `REFERRAL_REWARD_DISTRIBUTED` event:

1. Validates required fields (`referrerWallet`, `sourceWallet`, `tier`,
   `amount`, `distributedAt`, `ledger`). Malformed events are skipped with a
   warn-level log.
2. Rejects tiers outside `1..3`, non-positive amounts, and invalid timestamps.
3. Upserts a `ReferralEarning` row keyed on `(txHash, eventIndex)` and
   invalidates the referrer's cached summary/pages.
4. After the batch, checkpoints the highest processed ledger for gap
   detection (`updateIndexedLedger`).

Duplicates within a batch are removed up front via `dedupeChainEvents`.

Event shape:

```ts
interface ReferralRewardDistributedEvent {
   eventType: 'REFERRAL_REWARD_DISTRIBUTED';
   referrerWallet: string;
   sourceWallet: string;
   tier: 1 | 2 | 3;
   amount: string; // XLM, string for precision
   distributedAt: string; // ISO timestamp
   ledger: number;
   txHash: string;
   eventIndex: number;
   rewardId?: string;
}
```

## Endpoints

Both endpoints require a JWT (`Authorization: Bearer <token>`) whose wallet
matches the `:wallet` path param; a mismatch returns `401`.

### GET `/api/v1/referrals/:wallet/earnings`

Paginated earnings history, newest first.

| Query param | Type     | Default | Notes                                      |
| :---------- | :------- | :------ | :----------------------------------------- |
| `limit`     | integer  | `20`    | 1–100.                                     |
| `cursor`    | string   | –       | Opaque cursor from the previous page.      |
| `from`      | ISO date | –       | Inclusive lower bound (date or timestamp). |
| `to`        | ISO date | –       | Inclusive upper bound (date or timestamp). |

```json
{
   "success": true,
   "data": {
      "items": [
         {
            "id": "ckxyz",
            "tier": 1,
            "amount": 12.5,
            "sourceWallet": "GSOURCE...",
            "earnedAt": "2026-08-15T00:00:00.000Z",
            "txHash": "abc123"
         }
      ],
      "pagination": { "limit": 20, "hasMore": false, "nextCursor": null }
   }
}
```

`from` must be earlier than or equal to `to`, otherwise the request is
rejected with `400`.

### GET `/api/v1/referrals/:wallet/summary`

Total earnings, per-tier breakdown, and count of distinct referred wallets.
Cached in Redis for 2 minutes and invalidated when a new reward lands.

```json
{
   "success": true,
   "data": {
      "totalEarnings": 20,
      "earningsCount": 3,
      "referredWalletCount": 2,
      "tiers": { "tier1": 10, "tier2": 4, "tier3": 6 }
   }
}
```

## Pagination

The earnings list uses keyset pagination over `(earnedAt, id)` encoded into a
signed cursor (`utils/cursor.utils.ts`). Pages stay consistent even when new
rewards arrive between fetches. An invalid/tampered cursor returns `400`.
