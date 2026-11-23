# Current voting weight and tipping leaderboards

`GET /api/v1/governance/voting-weight/:wallet/:key_id` returns current holder weight,
active delegated weight, their total, and the active delegators with each wallet's
current balance. The wallet must be a checksummed Stellar account address.
A wallet with no holdings or incoming delegations receives zero weight.
Amounts are decimal strings so balances retain precision through JSON.
Self-delegation does not add a wallet's own balance twice. The response uses
current indexed balances; proposal-specific frozen snapshot weights remain
available through the existing proposal weight endpoint.

```json
{
  "success": true,
  "data": {
    "own_weight": "3.25",
    "delegated_weight": "4.5",
    "total": "7.75",
    "delegators": [{ "wallet": "G...", "amount": "4.5" }]
  }
}
```

Voting weights are cached in Redis for 60 seconds. Delegation set/revoke events
and committed balance changes invalidate all voting weights for the affected key.

`GET /api/v1/keys/:key_id/tips/leaderboard?limit=20` returns an array ranked by
total tipped, with `rank`, `wallet`, `total_tipped`, `tip_count`, and `anonymous`.
The limit must be one integer from 1 through 100. Ties are ordered deterministically.
A key with no tips returns an empty array.

Public wallets show their first six and final four characters, separated by an
ellipsis. Anonymous tips return `wallet: null` and `anonymous: true`. Public and
anonymous tips from the same sender form separate groups; their amounts are not
combined into an identifiable public entry. Tip history also hides anonymous
sender addresses. Older tips and events without an anonymity flag remain public.

The leaderboard is cached in Redis for 300 seconds. Every indexed TipSent event,
including a replay, invalidates that key's leaderboard and existing tip caches.
Both endpoints use HTTP `Cache-Control: no-store`, since browser and CDN caches
cannot receive event invalidations.

Delegation events resolve registered handles and addresses to canonical key IDs
before projection and invalidation. State, receipts, and audit activity commit
atomically. An inactive tombstone records an unknown delegation's revocation,
preventing older-ledger events from restoring revoked voting weight. Known
transaction ordinals order same-ledger events; events from one transaction use
their event index. When transaction ordinals are absent, distinct transactions
follow the ordered indexer stream, and receipts reject exact event replays.

The `20261121175000_add_delegation_position` migration adds these chain positions.
Legacy transaction ordinals remain null because their values are unavailable.
Known event indices are recovered from existing receipts.

The `20261121174000_add_tip_anonymity` migration adds a Boolean flag to `key_tips`
with a default of false. Regenerate the Prisma client after applying it.

Regression tests cover totals, zero holdings, self-delegation, aliases, anonymous
tip persistence, query validation, and cache invalidation. The PostgreSQL and
HTTP integration test uses `RUN_GOVERNANCE_TIPS_INTEGRATION=1` with a disposable
database initialized from the Prisma schema.
