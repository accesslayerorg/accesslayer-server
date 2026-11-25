# Zero-Downtime Migration Rules

Schema changes must not break the app version that is still serving traffic during a rollout. A rolling deploy runs old and new instances against the same database for a period of time, so every migration has to work with both.

This guide covers the rules that CI enforces and the expand / migrate / contract pattern for changes that cannot be made in one step. For naming, rollback, and irreversible migrations, see [database-migrations.md](./database-migrations.md).

## What CI checks

The `migration-safety` job in `.github/workflows/ci.yml` runs `scripts/check-migrations.ts` against every `prisma/schema/migrations/*/migration.sql` file that the pull request adds or changes. Historical migrations are not re-checked.

| Rule             | Fails when a new migration contains                                                    |
| ---------------- | -------------------------------------------------------------------------------------- |
| `drop-column`    | `DROP COLUMN`                                                                          |
| `drop-table`     | `DROP TABLE`                                                                           |
| `alter-type`     | `ALTER TYPE`, `SET DATA TYPE`, or `ALTER COLUMN ... TYPE`                              |
| `rename`         | `RENAME COLUMN` or `RENAME TO`                                                         |
| `index-not-concurrent` | `CREATE INDEX` or `DROP INDEX` without `CONCURRENTLY` on a table that existed before the migration |
| `concurrent-index-mixed` | a `CONCURRENTLY` index statement in a file with any other statement (see [Creating indexes](#creating-indexes)) |
| `missing-lock-timeout` | no `SET lock_timeout` statement (not required for a lone `CONCURRENTLY` index file) |
| `missing-statement-timeout` | no `SET statement_timeout` statement (same exemption)                       |
| `invalid-escape-hatch` | a `-- migration-safe:` comment with a reason shorter than 10 characters          |

Two exemptions apply automatically:

- A plain `CREATE INDEX` is allowed on a table that the same migration creates, because nothing is reading or writing that table yet.
- Comments and string literals are ignored, so text such as `-- DROP COLUMN is discussed here` does not trigger a rule.

Run the check locally before you push:

```bash
pnpm exec ts-node --transpile-only scripts/check-migrations.ts --base origin/main
```

## Starting every migration

Put these two lines at the top of each new `migration.sql`, except a file that holds only a `CONCURRENTLY` index (see [Creating indexes](#creating-indexes)). They make a migration give up instead of queueing behind a lock or running for minutes while the app waits:

```sql
SET lock_timeout = '5s';
SET statement_timeout = '30s';
```

`lock_timeout` aborts the statement if it cannot get its lock within five seconds, which is the usual cause of an outage during a migration. `statement_timeout` caps total runtime. If a migration hits either limit, Prisma marks it failed and nothing is half-applied, so retry it once the cause (usually a long transaction) is cleared.

## Expand, migrate, contract

Any change that removes or renames something has to happen in three releases, not one. Each release must be safe to run alongside the previous one.

### 1. Expand

Add the new shape without removing the old one. Everything here is safe while old instances are running:

- add a nullable column, or a column with a default;
- create a new table, and indexes on that table;
- create an index on an existing table with `CREATE INDEX CONCURRENTLY`, in its own migration file (see [Creating indexes](#creating-indexes)).

Adding an enum value (`ALTER TYPE ... ADD VALUE`) is flagged by the checker. Use a text column with an application-side allow-list instead, or add the value with an escape hatch and a reason.

The application writes to both the old and the new shape. Reads still use the old shape.

### 2. Migrate

Backfill existing rows into the new shape in batches. Use a script or a background worker, not a single `UPDATE` over the whole table. Verify the counts match before you move on.

Once every instance writes to the new shape and reads from it, the old shape is no longer used. Confirm this with a release, not an assumption.

### 3. Contract

Remove the old shape in a later release: `DROP COLUMN`, `DROP TABLE`, or the old index. By this point no running instance depends on it. Because this is the only destructive step, it is the one that can be flagged for code-owner review.

### Example: renaming a column

| Release | Migration                                              | App change                                    |
| ------- | ------------------------------------------------------ | --------------------------------------------- |
| 1       | Add `display_name`, nullable                           | Write both `name` and `display_name`          |
| 2       | Backfill `display_name` from `name` in batches         | Read `display_name` and fall back to `name`   |
| 3       | Drop `name`                                            | Only `display_name` remains                   |

Each release is safe to roll back to the one before it.

## The escape hatch

Some statements are safe even though they look risky. Examples include a column that has been unused for a full release cycle, or a table that holds only a few rows and is locked for milliseconds. For those, add a comment that gives the reason:

```sql
-- migration-safe: legacy_score column unused since release 2026.10; verified no reads in prod logs
SET lock_timeout = '5s';
SET statement_timeout = '30s';
ALTER TABLE "Creator" DROP COLUMN "legacy_score";
```

Rules:

- The reason must be at least 10 characters and must say why the statement is safe.
- The escape hatch waives only the statement rules (`drop-column`, `drop-table`, `alter-type`, `rename`, and `index-not-concurrent`). It never waives the timeout rules.
- Every use is reported as a notice on the pull request. A code owner must approve the change. The repository's `CODEOWNERS` review rule is the enforcement point, so the migration file must be in a code-owned path (`prisma/schema/migrations/` is a suggested entry).

## Creating indexes

Indexes on existing tables must use `CONCURRENTLY`:

```sql
CREATE INDEX CONCURRENTLY "Key_price_idx" ON "Key"("price");
```

`CONCURRENTLY` cannot run inside a transaction block, and Prisma can send a multi-statement file as one. So a file that contains a concurrent index must hold only that statement. The checker enforces this with `concurrent-index-mixed`, and it does not require the timeout `SET` lines for that file. The trade-off is that `lock_timeout` does not apply to that one statement. Keep concurrent index migrations small and run them off-peak.

## Compatibility check

Before merging a schema change, confirm the previous app version still works against the migrated database:

1. Deploy the migration to a staging database with sample data, while the previous release is still serving traffic.
2. Run the smoke suite against the previous release.
3. Only then roll out the new release.

The automated CI check covers the static rules above. The live compatibility run in step 2 is a manual release step for now.

## Related

- [Database migrations: naming, rollback, and irreversible changes](./database-migrations.md)
- [Release checklist](./release-checklist.md)
- `scripts/check-migrations.ts` and `src/utils/migration-safety.utils.ts`, which implement the rules above
