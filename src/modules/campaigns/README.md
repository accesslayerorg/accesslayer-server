# Seasonal campaign read API

Mounted under `/api/v1/campaigns`:

- `GET /` lists campaigns, criteria, raw-token reward pools and computed upcoming/active/ended status. `limit` defaults to 25 (max 100); `offset` defaults to 0.
- `GET /:campaign_id/eligibility/:wallet` returns on-chain eligibility, recorded criteria progress, proportional reward estimate, one-time claimed state, `available_at`, and current claimable amount. Wallets without a WalletQualified event have no recorded score and are ineligible.
- `GET /:campaign_id/leaderboard?limit=` lists qualifying wallets by descending raw score and stable wallet tie break.

All amount/score fields are exact integer strings in the contract's base units. Reward entitlement follows `reward_pool * wallet_score / total_score` with integer floor, matching [seasonal-rewards](https://github.com/accesslayerorg/accesslayer-contracts/blob/main/seasonal-rewards/src/lib.rs). Claimable amount is zero before the end timestamp, after any claim (including zero payout), or if multiplication would overflow the contract's signed i128. HoldDays scores are seconds; its threshold is days. Volume scores are raw contract volume; Trades scores are trade counts.

The indexer accepts named CampaignCreated/WalletQualified/RewardClaimed events and on-chain `camp_new`/`qual`/`claim` topics carrying a campaign identifier. It journals each chain position once. Eligibility and claim data can arrive before creation without being discarded. Cumulative total_score uses the maximum authoritative qualification total, which is monotonic in this contract. Redis caches expire after 60 seconds and all list/eligibility/leaderboard keys are invalidated on any campaign event. Cached responses recompute date status and claimability at request time.

The existing daily qualification cron and qualification logs remain available. Database/HTTP regression coverage is in `campaign.routes.integration.test.ts`, enabled with `RUN_CAMPAIGN_INTEGRATION=1` and a disposable PostgreSQL schema; unit tests cover parsing, replay/order, payout arithmetic, caches and time boundaries.
