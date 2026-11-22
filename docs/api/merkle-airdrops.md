# Merkle airdrops

## Create and retrieve allocations

`POST /api/v1/admin/airdrops` accepts a key creator's signed body:

```json
{
  "keyId": "creator-key-id-or-handle",
  "allocations": [
    { "address": "a-valid-Stellar-account-address", "amount": "10000000" }
  ]
}
```

Use the existing Stellar signature headers: `x-wallet-address`,
`x-wallet-signature`, and `x-timestamp`. The signature covers
SHA256(JSON.stringify(body) + timestamp). The signing wallet must be registered
to the user who owns the creator key. Amounts are positive integer strings in
the contract's smallest units, bounded by signed i128. Empty lists, duplicates,
invalid account checksums, zero amounts, and lists over 10,000 allocations return
400. A key that does not exist returns 404; a different creator returns 403.

The response returns `id`, canonical `keyId`, `root`, and
`allocationCount`. Submitting the same key/root again returns the existing tree.
The endpoint stores allocations; publishing the root on chain uses the contract's
deployment/transaction flow.

`GET /api/v1/airdrops/:id/proof?address=...` returns `root`, exact decimal
`amount`, `index`, a hexadecimal sibling `proof` array, and
`claimed`/`claimedAt`. An ineligible account returns 404.

`GET /api/v1/airdrops/:id/claims?limit=25&cursor=...` lists allocations in leaf
index order with their claim flags and transaction hashes. Limits are 1–100.
Use `nextCursor` from the prior response to retrieve the next page.

## Contract hashing

The implementation matches
[`creator-keys/src/issue_primitives.rs`](https://github.com/accesslayerorg/accesslayer-contracts/blob/main/creator-keys/src/issue_primitives.rs)
in the contracts repository:

- Leaf: SHA256(ScVal XDR of the account address || 16-byte big-endian signed i128).
- Parent: SHA256(smaller 32-byte hash || larger 32-byte hash), compared bytewise.
- Odd nodes are promoted unchanged. Their proofs omit a sibling for that level.
- The contract verifier folds the sibling array without index-dependent sides.

The server's event-integrity Merkle utility hashes different leaves and is not
used for allocations.

## Claim event normalization

The contract currently exposes pure airdrop hashing and verification primitives,
with entrypoints left to follow-up contract work. This indexer accepts
`airdrop_claimed`, `AirdropClaimed`, or `AIRDROP_CLAIMED` after ingestion
normalizes a claim to `keyId`, `root`, recipient `address`, integer
`amount`, `ledger`, `txHash`, and `eventIndex`; `claimedAt` is optional.
Aliases `key_id`, `recipient`/`claimer`, and `merkle_root` are supported.
The root can be hexadecimal or a decoded 32-byte array.

A deployed event adapter must supply the root/key/recipient identity. The API ID
is an off-chain ID and is never guessed from a numerical contract ID. The
indexer requires the event amount to match the stored allocation, atomically
marks it once, and preserves the first claim on replay. Malformed events go to
the DLQ. Missing allocations and database failures propagate so ingestion can
retry rather than lose claim status.

## Regression coverage

Unit tests include an independently encoded ScVal/i128 leaf fixture, sorted-pair
roots, first/middle/last and odd proofs, tampering, validation, ownership, exact
large amounts, and replay-safe claim updates. The opt-in
`RUN_AIRDROP_INTEGRATION=1` suite exercises signed HTTP creation, proof retrieval,
claim events, replay, and pagination against a disposable Prisma database.
