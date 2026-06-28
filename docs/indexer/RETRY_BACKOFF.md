# Indexer Retry Policy & Backoff

This document describes how indexer jobs retry on failure, the backoff strategy
between attempts, and what happens when a job exhausts its retries. It exists so
contributors adding or modifying indexer jobs understand the expected behavior
and avoid silent job loss.

See also: [`FEATURE_FLAGS.md`](./FEATURE_FLAGS.md), [`DLQ_WORKFLOW.md`](./DLQ_WORKFLOW.md),
[`EVENT_PROCESSING.md`](./EVENT_PROCESSING.md).

## Backoff strategy

Retry delays are computed by `getBackoffWithJitter()` in
`src/utils/jitter.utils.ts`:

```
delay = applyJitter( min(maxDelayMs, baseDelayMs * 2^attempt), jitterFactor )
```

- **Exponential growth** — the base delay doubles with each attempt
  (`baseDelayMs * 2^attempt`), so retries back off progressively.
- **Cap** — the delay is clamped to `maxDelayMs` so it never grows unbounded.
- **Jitter** — `applyJitter()` multiplies the delay by a random factor in
  `[1 - jitterFactor, 1 + jitterFactor]` to avoid a thundering herd when many
  jobs fail at once.

| Parameter      | Default   | Meaning                                                  |
| -------------- | --------- | -------------------------------------------------------- |
| `baseDelayMs`  | `1000`    | Delay before the first retry (`attempt = 0`).            |
| `maxDelayMs`   | `30000`   | Upper bound on any single retry delay.                   |
| `jitterFactor` | env value | Random spread, from `INDEXER_JITTER_FACTOR` (see below). |

`attempt` is 0-indexed, so successive delays are roughly `1s, 2s, 4s, 8s, 16s,
30s, 30s, …` (before jitter).

## Configuration values

The retry/backoff behavior is controlled by these environment variables
(validated at boot by `runIndexerFeatureFlagsStartupCheck()`):

| Env var                                | Type            | Default  | Controls                                                                |
| -------------------------------------- | --------------- | -------- | ----------------------------------------------------------------------- |
| `INDEXER_JITTER_FACTOR`                | number `[0, 1]` | `0.1`    | Jitter spread applied to every backoff delay.                           |
| `ENABLE_INDEXER_DLQ`                   | boolean         | `true`   | Route retry-exhausted / terminal jobs to the dead-letter queue.         |
| `ENABLE_INDEXER_DEDUPE`                | boolean         | `true`   | Required when the DLQ is enabled; dedupe keys identify repeat failures. |
| `INDEXER_HEARTBEAT_STALE_THRESHOLD_MS` | number ms       | `300000` | When the indexer is considered stalled (no progress).                   |
| `BACKGROUND_JOB_LOCK_TTL_MS`           | integer ms      | `300000` | Lock TTL that prevents two workers from retrying the same job at once.  |

## Exhaustion behavior

When a job exhausts its retry attempts (or hits a terminal, non-retryable
error), it is moved to the **Dead-Letter Queue** via `moveToDLQ()` in
`src/utils/indexer-dlq.utils.ts`. The DLQ record (`indexerDLQ` table) captures:

- `jobType` — the kind of job that failed,
- `payload` — the original job payload, so it can be replayed,
- `retryCount` — how many attempts were made before giving up,
- `failureReason` / `errorDetails` — why it ultimately failed.

Consequences:

- **Jobs are parked, not lost.** A retry-exhausted job is preserved in the DLQ
  for inspection and manual replay rather than disappearing.
- **DLQ depth is observable.** `getDLQDepth()` and `syncDLQMetrics()` expose the
  current backlog to the metrics registry; a growing DLQ indicates a systemic
  failure that needs attention.
- **DLQ disabled is risky.** If `ENABLE_INDEXER_DLQ=false`, retry-exhausted jobs
  are dropped with only a log line — enable the DLQ in any environment where
  silent job loss is unacceptable. (`ENABLE_INDEXER_DLQ=true` also requires
  `ENABLE_INDEXER_DEDUPE=true`.)

## Guidance for new indexer jobs

- Use `getBackoffWithJitter(attempt, …)` for retry delays instead of a fixed
  sleep, so behavior is consistent and jittered.
- Choose a sensible maximum attempt count for the job, then call `moveToDLQ()`
  once it is reached — do not loop forever.
- Keep payloads in the DLQ replayable: store everything needed to re-run the job.
