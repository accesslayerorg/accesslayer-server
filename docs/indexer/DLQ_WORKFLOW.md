# Indexer Dead-Letter Queue (DLQ) Workflow

The Indexer DLQ stores jobs that have failed all retry attempts. This document outlines the workflow for monitoring and reprocessing these jobs.

## 1. Detection

Failures are moved to the `IndexerDLQ` table when the retry budget is exhausted.
Monitoring systems should alert when:

- `IndexerDLQ` count > 0.
- High frequency of specific `jobType` failures.

## 2. Investigation

To investigate a failure, query the `IndexerDLQ` table:

```sql
SELECT * FROM "IndexerDLQ" WHERE "jobType" = 'CREATOR_REGISTERED' ORDER BY "createdAt" DESC;
```

Check `failureReason` and `errorDetails` for root causes (e.g., malformed payload, database constraint violation, or downstream service outage).

## 3. Reprocessing Workflow

Reprocessing is currently a manual or script-based process.

### Option A: Manual Trigger

1. Fix the underlying issue (e.g., deploy a bug fix or update dependent data).
2. Use a management script to re-inject the `payload` into the indexing pipeline.
3. Once successful, delete the entry from `IndexerDLQ`.

### Option B: Automatic Recovery (Future)

An admin endpoint or background task could be implemented to:

1. Batch select DLQ items.
2. Attempt reprocessing.
3. Remove items on success or update `failureReason` on repeat failure.

## 4. Purging

Dead letters that are confirmed as "unfixable" (e.g., invalid legacy data that can no longer be processed) should be archived or purged to keep the table size manageable.
