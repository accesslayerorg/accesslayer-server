# Key LP reward accrual (#1196)

Liquidity providers on a creator key earn a pro-rata share of that key's
trading fees. Rewards accrue hourly and are claimed through the API.

## Model

| Table                    | Purpose                                                                 |
| ------------------------ | ----------------------------------------------------------------------- |
| `key_lp_positions`       | One row per (key, wallet): `lp_tokens`, `entry_price`, accrued/claimed. |
| `key_lp_reward_pools`    | Per-key pool balance (carry-over) and accrual cursor.                   |
| `key_lp_reward_epochs`   | Audit row per processed (key, epoch): volume, funded, distributed.      |
| `key_lp_reward_accruals` | Each position's share of each epoch.                                    |
| `key_lp_reward_claims`   | Claims, with payout `status` (`pending` → `settled` / `failed`).        |

Positions are written by the LP indexer: `LiquidityAdded` adds
`lpTokens` (falling back to `amount`) at `entryPrice`, re-averaging the
entry price; `LiquidityRemoved` zeroes the balance. Accrued rewards stay
claimable after withdrawal.

Units: `lpTokens`, `eligibleLpTokens` and `entryPrice` are 7-decimal strings.
Reward amounts are integer base units (stroops), the same unit as
`price × quantity` on trades.

## Hourly accrual

Epochs are fixed UTC hours `[epochStart, epochEnd)`. The job runs at startup
and one minute after each hour boundary (the delay lets trades in flight at
the boundary commit). For each key, oldest pending epoch first:

1. **Fund**: `pool += floor(volume × LP_FEE_BPS / 10_000)`, where volume is
   `Σ price × quantity` over trades indexed during the epoch.
2. **Distribute**: the whole pool is split by each position's
   `eligibleLpTokens` using largest-remainder rounding. Shares sum exactly to
   the pool and each is within one base unit of its exact value. With no
   eligible liquidity the pool carries over.
3. **Roll eligibility**: `eligibleLpTokens := lpTokens` for the next epoch,
   except for positions that deposited after the epoch ended.

So a new position is first paid in the **next** epoch after it is opened.
Withdrawals reduce eligibility immediately. Epoch processing is one
transaction guarded by the per-key cursor and a unique `(keyId, epochStart)`
row, so re-runs and multiple instances never double-distribute.

| Env var                                | Default | Meaning                                  |
| -------------------------------------- | ------- | ---------------------------------------- |
| `LP_FEE_BPS`                           | `30`    | Share of trade volume funding the pool.  |
| `LP_REWARD_ACCRUAL_ENABLED`            | `true`  | Start the hourly job.                    |
| `LP_REWARD_ACCRUAL_MAX_CATCHUP_EPOCHS` | `24`    | Missed epochs processed per key per run. |

A key seen for the first time starts at the latest settled epoch; earlier
trades are not back-funded.

## `GET /api/v1/keys/:keyId/lp/:wallet`

Public. `404` for an unknown key or a wallet with no position.

```json
{
   "success": true,
   "data": {
      "keyId": "ck…",
      "wallet": "GA…",
      "lpTokens": "100.0000000",
      "entryPrice": "2.0000000",
      "poolSharePct": "25.0000",
      "eligibleLpTokens": "100.0000000",
      "accruedRewards": "1500",
      "claimedRewards": "1000",
      "claimable": "500",
      "lastAccruedEpochEnd": "2026-11-22T11:00:00.000Z",
      "createdAt": "…",
      "updatedAt": "…"
   }
}
```

`poolSharePct` is the wallet's share of the key's current total `lp_tokens`.
`claimable = accruedRewards − claimedRewards`.

## `POST /api/v1/keys/:keyId/lp/:wallet/claim`

Requires `Authorization: Bearer <token>` for the same wallet (`401`
otherwise). Transfers the full claimable balance. In one transaction it moves
claimable into `claimedRewards` (compare-and-set, so concurrent claims cannot
pay twice) and records a `pending` payout in `key_lp_reward_claims` for
settlement. Afterwards `claimable` is `0`.

```json
{
   "success": true,
   "data": {
      "claimId": "ck…",
      "amount": "500",
      "status": "pending",
      "accruedRewards": "1500",
      "claimedRewards": "1500",
      "claimable": "0",
      "claimedAt": "…"
   }
}
```

`409` when nothing is claimable or a concurrent claim won. `404` for an
unknown key or position.
