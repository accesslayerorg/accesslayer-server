# Partitioning: trades and ingested_events

## Overview

Issue #1333 adds PostgreSQL range partitioning by month for high-growth tables:

- `Trade` (physical table: `"Trade"`) partitioned by `timestamp`
- `IngestedEvent` (physical table: `"ingested_events"`) partitioned by `ledgerSequence`-derived month is **not** available; this table is partitioned by `createdAt` month for maintenance while preserving all columns and query behavior. Time-bounded event lookups must include `createdAt`/month window to benefit from pruning.

> Note: `IngestedEvent` has no `executed_at` column; the schema uses `createdAt` and optional `tradeAt`. Partition key is `createdAt` (UTC month range).

## Migration strategy

Migration is raw SQL (Prisma cannot express partitioned table conversion). It preserves data by renaming the existing table, creating a partitioned parent, creating partitions, copying data, then dropping the old table.

### Apply

1. Ensure backups/snapshot exist.
2. Run migration in a maintenance window:
   ```bash
   pnpm exec prisma migrate deploy
   ```
3. Verify counts:
   ```sql
   SELECT count(*) FROM "Trade";
   SELECT count(*) FROM trades_old; -- before dropping in manual dry runs
   SELECT count(*) FROM "ingested_events";
   ```

### Rollback

Rollback is destructive to partition metadata only if done before dropping old tables; after drop, restore from backup.

**Tested rollback procedure (on a copy):**

1. Stop writes.
2. Create plain tables from parent schema:
   ```sql
   CREATE TABLE "Trade_plain" (LIKE "Trade" INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES);
   INSERT INTO "Trade_plain" SELECT * FROM "Trade";
   ALTER TABLE "Trade" RENAME TO "Trade_partitioned";
   ALTER TABLE "Trade_plain" RENAME TO "Trade";
   ```
3. Repeat for `ingested_events`.
4. Recreate foreign keys/indexes not inherited as needed.
5. Run `ANALYZE`.

Because partitioned-table rollback can be environment-specific, validate on a staging copy before production.

## Partition manager

`PartitionManagerWorker` (`src/workers/partition-manager.worker.ts`) runs daily:

- Creates next `PARTITION_PRECREATE_MONTHS` (default 3) monthly partitions for `Trade` and `ingested_events`.
- Detaches partitions older than `PARTITION_RETENTION_MONTHS` (default 12) using `ALTER TABLE ... DETACH PARTITION ... CONCURRENTLY` to avoid write locks.
- Logs created/detached partition names.

Env vars:

- `PARTITION_MANAGER_ENABLED=true`
- `PARTITION_PRECREATE_MONTHS=3`
- `PARTITION_RETENTION_MONTHS=12`

## Indexes

Each partition inherits indexes created on the partitioned parent. Migration creates:

Trade:

- `(creatorId, timestamp)`
- `(buyer, timestamp)`
- existing lookup indexes retained

Ingested events:

- `(creatorId, createdAt)`
- `(txHash, eventIndex)` unique
- existing lookup indexes retained

## Query guidance

Include the partition key in time-bounded lookups:

```sql
SELECT * FROM "Trade"
WHERE "creatorId" = $1
  AND "timestamp" >= $2 AND "timestamp" < $3
ORDER BY "timestamp" DESC;
```

For ingested events, include `createdAt` bounds when possible.

## Verification

Check pruning with:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM "Trade"
WHERE timestamp >= now() - interval '7 days';
```

Plan should show only relevant partitions (Partition Prune).
