# Read-Model Rebuild

This document describes how to rebuild derived read models when the underlying event log or primary data changes.

## When to rebuild

- Schema migration changed a computed column or index
- A bug was fixed in the indexing logic and historical records need correction
- A new read model was added and must be backfilled from existing data
- Data corruption was detected in a read-model table

## Prerequisites

Before starting a rebuild:

1. **Confirm upstream data is consistent.** The primary source (on-chain event log or primary DB tables) must be in a known-good state before deriving from it.
2. **Coordinate with operators.** Notify the team before a long-running rebuild; reads against the affected model may return stale data during the operation.
3. **Run in a non-production environment first.** Validate row counts and spot-check records before executing against production.
4. **Take a snapshot.** Back up the target read-model table so you can roll back if the rebuild produces incorrect results.

```bash
# Example: back up a read-model table before rebuild
pg_dump $DATABASE_URL -t creator_ownership_reads > backup-creator_ownership_reads-$(date +%Y%m%d).sql
```

## Rebuild flow

```
Source of truth (events / primary tables)
         │
         ▼
  Clear / truncate target read-model table
         │
         ▼
  Replay events or re-derive rows (batch insert)
         │
         ▼
  Verify row count + spot-check sample rows
         │
         ▼
  Re-enable live indexer writes to the table
```

### Step-by-step

1. **Pause or fence the live indexer** that writes to the read model, or ensure it is idempotent enough to run concurrently with the rebuild.

2. **Truncate or soft-delete** the stale read-model rows:
   ```sql
   TRUNCATE TABLE creator_ownership_reads;
   -- or, for an incremental rebuild without full downtime:
   UPDATE creator_ownership_reads SET rebuild_pending = true;
   ```

3. **Run the rebuild script** (location: `scripts/rebuild-read-model.sh` once implemented):
   ```bash
   pnpm ts-node src/scripts/rebuild-read-model.ts --model=creator_ownership_reads
   ```
   The script must process records in batches (recommended batch size: 500) and log progress at each checkpoint.

4. **Verify output:**
   ```sql
   SELECT COUNT(*) FROM creator_ownership_reads;
   -- Compare to expected count derived from source tables
   ```
   Spot-check a sample of records against the source of truth.

5. **Resume the live indexer.** If fenced, lift the fence. If the indexer was paused, restart it and confirm it picks up from the correct cursor position.

## Expected duration

| Table size | Estimated rebuild time |
|---|---|
| < 10k rows | < 1 minute |
| 10k – 100k rows | 2–10 minutes |
| 100k – 1M rows | 15–60 minutes |
| > 1M rows | Plan for multi-hour window; use batched pagination |

Duration depends on DB instance size, network, and whether indexes are rebuilt inline or deferred.

## Rollback guidance

If the rebuild produces incorrect data:

1. Stop the live indexer writes to the affected table.
2. Restore from the snapshot taken in the prerequisites step:
   ```bash
   psql $DATABASE_URL < backup-creator_ownership_reads-<date>.sql
   ```
3. Investigate the root cause before re-attempting the rebuild.
4. Open a postmortem issue if production reads were affected.

## Safety notes

- Never rebuild against a live production table without a rollback snapshot.
- Do not run multiple concurrent rebuilds against the same target table.
- If the rebuild is interrupted mid-flight, the table may be in a partially rebuilt state. Truncate and restart from step 2 rather than resuming from an unknown offset.
