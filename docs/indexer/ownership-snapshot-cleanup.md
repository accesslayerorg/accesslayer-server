# Ownership Snapshot Cleanup Scaffold

This scaffold adds a scheduled cleanup job that targets expired ownership snapshot rows.

The implementation is intentionally conservative:

- it runs only when explicitly enabled
- it supports dry-run mode by default
- it skips cleanup if the target table does not exist yet

## Environment variables

Use the following variables to control behavior:

- `OWNERSHIP_SNAPSHOT_CLEANUP_ENABLED` (default: `false`)
- `OWNERSHIP_SNAPSHOT_CLEANUP_INTERVAL_MINUTES` (default: `60`)
- `OWNERSHIP_SNAPSHOT_RETENTION_DAYS` (default: `30`)
- `OWNERSHIP_SNAPSHOT_CLEANUP_DRY_RUN` (default: `true`)
- `OWNERSHIP_SNAPSHOT_TABLE_NAME` (default: `creator_ownership_snapshots`)

## How cleanup works

On each run, the job computes a cutoff timestamp as:

`now - OWNERSHIP_SNAPSHOT_RETENTION_DAYS`

Then it checks whether the configured table exists.

- In dry-run mode, it only counts rows where `expiresAt < cutoff`.
- In non-dry-run mode, it deletes rows where `expiresAt < cutoff`.

## Local validation steps

1. Configure `.env`:

```bash
OWNERSHIP_SNAPSHOT_CLEANUP_ENABLED=true
OWNERSHIP_SNAPSHOT_CLEANUP_INTERVAL_MINUTES=1
OWNERSHIP_SNAPSHOT_RETENTION_DAYS=30
OWNERSHIP_SNAPSHOT_CLEANUP_DRY_RUN=true
OWNERSHIP_SNAPSHOT_TABLE_NAME=creator_ownership_snapshots
```

2. Start the server:

```bash
pnpm dev
```

3. Confirm logs show one of the following:

- `Ownership snapshot cleanup dry-run completed`
- `Ownership snapshot cleanup skipped because target table was not found`

4. Run tests for the scaffold:

```bash
pnpm exec jest src/jobs/ownership-snapshot-cleanup.job.test.ts
```

5. Optional delete validation (only when safe): set `OWNERSHIP_SNAPSHOT_CLEANUP_DRY_RUN=false`, run locally against non-production data, and verify delete counts in logs.
