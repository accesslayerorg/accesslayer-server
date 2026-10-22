# Referral API additions

All endpoints below require a wallet JWT. If `wallet` is supplied to the read endpoints, it must equal the authenticated wallet; the API never accepts another wallet's address as authority.

## Stats

`GET /api/v1/referrals/stats?wallet=<wallet>` returns `totalReferees`, `totalEarned`, and the current `pendingRewards`. Lifetime earnings and referral counts come from the indexed database. Pending rewards are read from the Soroban `get_referral_earnings` view for each creator contract with referral activity, so an RPC failure returns `503` instead of an outdated balance.

## History

`GET /api/v1/referrals/history?wallet=<wallet>&limit=20&cursor=<cursor>` returns reward events newest first. Pages are keyset-paginated with a signed cursor; `limit` is bounded to 100.

## Claim transaction

`POST /api/v1/referrals/claim` accepts `{ "keyId": "<creator-key-id>" }` and returns an unsigned transaction calling `claim_referral_rewards` on that creator key's contract. The wallet in the JWT is the transaction source and contract argument. The response includes the on-chain pending amount for the selected key. The client must inspect, sign, and submit the XDR; the API never signs or submits it.

The existing `/register` route and trade indexer maintain a database referral ledger; they do not submit the CreatorKeys contract's `register_referrer` call. The claim endpoint reads the contract's own per-key balance, so it only returns a claim transaction for balances accrued by an on-chain referral registration. Database-only rewards are not claimable through that call.

The current `creator-keys` contract implementation clears the stored referral balance and emits a claim event but does not transfer a token. This endpoint therefore only builds the contract call; it must not be presented as a completed payout. Contract work is still required to connect database registration/accrual to on-chain state and transfer funds before the claim flow can make that guarantee.
