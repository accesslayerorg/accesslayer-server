# Indexer Contributor Expectations

This guide is for contributors modifying the indexer, replay tooling, or any
code that changes how on-chain events become read-model updates.

## Invariants to Preserve

- Event processing must remain idempotent. Replaying the same event should not
  create duplicate rows or double-apply state transitions.
- Event ordering matters when a downstream read model depends on the chain
  sequence. Preserve ledger and event index ordering unless the change
  explicitly introduces a new ordering rule.
- Deduplication should continue to happen before a batch is processed so the
  same on-chain event is not handled twice in one pass.
- Background jobs should remain replay-safe. A retried job should either no-op
  or converge to the same state as the original run.
- Any DLQ or retry behavior should keep the original failure context intact so
  operators can diagnose the failure without guessing.

## Testing Expectations

- Add or update unit tests for helper logic, filtering, deduplication, or
  state transition behavior.
- Add integration coverage when the change affects request handling, replay
  flow, or cache/read-model consistency.
- Run the narrowest targeted test set first, then the broader repo checks
  before opening a PR.
- If a change touches generated Prisma types or schema-dependent code, run the
  generation step again before testing.

## Deployment Considerations

- Avoid deploying indexer changes without confirming the replay path is safe on
  existing data.
- Review any feature flags that control dedupe, DLQ handling, or cursor
  staleness warnings before rollout.
- If a change affects backfill or replay timing, verify the job lock TTL still
  covers the expected runtime.
- Monitor DLQ volume, replay logs, and stale-cursor warnings after deployment
  so regressions are visible quickly.
