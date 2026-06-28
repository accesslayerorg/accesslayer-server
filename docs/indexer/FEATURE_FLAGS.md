# Indexer Feature Flags

The indexer subsystem is gated by a small set of boolean env vars plus the
threshold values they reference. Every flag is validated at boot by
`runIndexerFeatureFlagsStartupCheck()` in
`src/utils/indexer-flags-startup-check.utils.ts`. Misconfigurations are
collected into a single error so an operator can fix every issue in one
pass — the server refuses to start until all listed issues are resolved.

## Flags

| Env var                                   | Type            | Default          | Purpose                                                                                       |
| ----------------------------------------- | --------------- | ---------------- | --------------------------------------------------------------------------------------------- |
| `ENABLE_INDEXER_DEDUPE`                   | boolean         | `true`           | Drop duplicate chain events by `(transactionHash, eventIndex)` before processing.             |
| `ENABLE_INDEXER_DLQ`                      | boolean         | `true`           | Move events that fail after retries to the dead-letter queue. Requires dedupe to be enabled.  |
| `ENABLE_INDEXER_CURSOR_STALENESS_WARNING` | boolean         | `true`           | Emit a structured `warn` log when the indexer cursor falls behind by more than the threshold. |
| `INDEXER_JITTER_FACTOR`                   | number `[0, 1]` | `0.1`            | Random jitter applied to indexer poll intervals.                                              |
| `INDEXER_CURSOR_STALE_AGE_WARNING_MS`     | integer ms      | `300000` (5 min) | How old the cursor must be before the staleness warning fires.                                |

## Cross-field invariants enforced at startup

- `INDEXER_JITTER_FACTOR` must be a finite number in `[0, 1]`.
- `INDEXER_CURSOR_STALE_AGE_WARNING_MS` must be a positive integer.
- If `ENABLE_INDEXER_CURSOR_STALENESS_WARNING=true`, the threshold must be
  at least `1000ms`. Either disable the flag or raise the threshold.
- `ENABLE_INDEXER_DLQ=true` requires `ENABLE_INDEXER_DEDUPE=true`. The DLQ
  uses the dedupe key to identify repeated failures; running DLQ without
  dedupe causes duplicate DLQ entries.

## Failure mode

If any invariant fails, the server logs a structured `error` entry with
the full list of issues and exits with code `1`:

```
Refusing to start: indexer feature flags are misconfigured
  issues:
    - INDEXER_JITTER_FACTOR must be a number between 0 and 1 (got 5)
    - ENABLE_INDEXER_DLQ is on but ENABLE_INDEXER_DEDUPE is off — …
```

## Validating locally

Set the env vars you want to verify and run `pnpm dev`. The startup log
emits one info line confirming the validated values.
