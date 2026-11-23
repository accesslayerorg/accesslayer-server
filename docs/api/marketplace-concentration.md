# Marketplace enforcement and holder concentration

All routes below use the existing /api/v1 API prefix and success envelope.

- GET /marketplaces returns currently approved addresses and approval timestamps.
  The registry list is cached for 300 seconds and invalidated by approval,
  revocation and royalty-enforcement events.
- GET /keys/:keyId/royalty-enforcement returns keyId, royaltyEnforced and locked.
  Keys without an enforcement event return false for both flags. Unknown keys
  return 404. The key detail response also includes royaltyEnforced.
- GET /keys/:keyId/concentration?includeContracts=false returns holderCount,
  top1Share, top5Share, top10Share, giniCoefficient and concentrationLevel.
  Shares and the Gini coefficient are fractions from 0 to 1. Only positive
  indexed balances count; the share denominator is the sum of included balances.
  An empty key has zero shares/Gini; a single holder has Gini 0 and top1Share 1.

Concentration excludes Soroban contract addresses and registered/deployed key
addresses, including the bonding-curve reserve, unless includeContracts=true.
CONCENTRATION_EXCLUDED_ADDRESSES accepts a comma-separated list of additional
reserve or known contract accounts. Cached variants remain separate and expire
after 300 seconds. Committed balance changes invalidate both variants.

CONCENTRATION_MEDIUM_THRESHOLD defaults to 0.25 and
CONCENTRATION_HIGH_THRESHOLD defaults to 0.5. The concentration label compares
top1Share to these inclusive thresholds: below medium is low, at or above medium
is medium, and at or above high is high. Thresholds must be fractions in [0, 1],
with medium below high; invalid configuration fails validation at startup.

Registry events use txHash/eventIndex receipts to avoid duplicate state changes.
Lower-ledger events cannot replace newer state. When transactionIndex (or
txIndex) is provided, state updates also compare transaction/event order within
the ledger. Without a transaction index, distinct same-ledger events follow
the ingestion stream's order. Within the same transaction, lower event indexes
cannot overwrite higher ones even without a transaction index. Enforcement
identifiers resolve to canonical creator/registered-key IDs; unknown identifiers
remain indexed and can be read through known aliases after registration.
Event payloads accept the snake_case or camelCase
field names described by the respective contract.
