# Database Migrations

This document describes the naming conventions for Prisma migration files, the rollback process for development and production environments, and guidance on irreversible migrations.

---

## 1. Migration Naming Convention

All database migrations are managed via [Prisma Migrate](https://www.prisma.io/docs/orm/prisma-migrate). Migration files are generated using the `prisma migrate` CLI and follow a strict naming convention.

### File Name Format

```
<timestamp>_<description>
```

| Component     | Format                                                  | Example                    |
| :------------ | :------------------------------------------------------ | :------------------------- |
| `timestamp`   | UTC timestamp in `YYYYMMDDHHMMSS`                       | `20260624120000`           |
| `separator`   | Underscore (`_`)                                        | `_`                        |
| `description` | Lowercase, hyphen-delimited words describing the change | `add_creator_wallet_index` |

**Full example:**

```
20260624120000_add_creator_wallet_index
```

This produces a directory structure under `prisma/schema/migrations/`:

```
prisma/schema/migrations/
└── 20260624120000_add_creator_wallet_index/
    ├── migration.sql
    └── migration_lock.toml
```

### Naming Rules

1. **Timestamps must be strictly increasing.** Never create a migration with a timestamp older than the latest existing migration.
2. **Descriptions use snake_case** (underscore-delimited) to keep file paths readable.
3. **Descriptions should be brief but descriptive** — enough to identify the purpose at a glance (e.g., `add_creator_wallet_index`, `remove_deprecated_balance_column`).
4. **Do not rename migration directories after creation.** Prisma tracks applied migrations in the `_prisma_migrations` table by directory name; renaming breaks the link.

### Generating a Migration

```bash
# After editing a .prisma schema file, run:
pnpm exec prisma migrate dev --name add_creator_wallet_index
```

Prisma automatically prepends the UTC timestamp. The resulting directory will be:

```
prisma/schema/migrations/20260624120000_add_creator_wallet_index/migration.sql
```

### Checking Migration Status

```bash
pnpm exec prisma migrate status
```

This shows which migrations have been applied, which are pending, and whether the database schema matches the expected state from the Prisma schema files.

---

## 2. Rollback Process

### Development

In development, you can roll back migrations interactively using Prisma's built-in reset or by applying a down migration manually.

#### Option A: Full Reset (fast, destructive)

This drops all data and re-applies all migrations from scratch. Use this when schema drift is severe or when you do not need to preserve development data.

```bash
pnpm exec prisma migrate reset
```

- Drops the database and recreates it.
- Re-applies all migrations.
- Optionally runs the seed script.
- **All data in the development database is lost.**

#### Option B: Interactive Rollback (preserves data)

To roll back the most recent migration while keeping data:

1. Identify the migration to roll back:

   ```bash
   pnpm exec prisma migrate status
   ```

2. Edit the generated `migration.sql` to create a **down migration** script that reverses the SQL (see Section 3 for guidance on writing reversible migrations).

3. Apply the rollback manually via `psql`:

   ```bash
   psql "$DATABASE_URL" < path/to/down-migration.sql
   ```

4. Remove the migration record from `_prisma_migrations` so Prisma knows it is no longer applied:

   ```sql
   DELETE FROM _prisma_migrations WHERE migration_name = '20260624120000_add_creator_wallet_index';
   ```

5. Delete the migration directory:

   ```bash
   rm -rf prisma/schema/migrations/20260624120000_add_creator_wallet_index
   ```

6. Verify the state:

   ```bash
   pnpm exec prisma migrate status
   # Should show no pending migrations and the rolled-back schema as current.
   ```

#### Option C: Reset to a Specific Migration

Prisma does not natively support "rolling back to version N." Instead, reset and re-apply up to a target migration:

```bash
# 1. Reset the database
pnpm exec prisma migrate reset

# 2. Apply migrations up to (and including) a specific one
pnpm exec prisma migrate resolve --applied "20260623100000_previous_migration_name"
```

> [!WARNING]
> This approach recreates the database from scratch. Do not use this on a database with production data.

### Production

Rolling back a migration in production carries inherent risk. Follow the **forward-only** principle: prefer deploying a new migration that undoes the change rather than reverting an already-applied migration.

#### Safe Rollback (Recommended)

1. **Create a new migration** that reverses the schema change:

   ```sql
   -- Example: undo "DROP COLUMN IF EXISTS balance"
   ALTER TABLE creator ADD COLUMN IF NOT EXISTS balance DECIMAL(20, 7) NOT NULL DEFAULT 0;
   ```

2. Generate the migration:

   ```bash
   pnpm exec prisma migrate dev --name revert_add_creator_wallet_index
   ```

3. **Deploy the rollback migration** as part of a standard release.

4. **Verify** the schema is restored:

   ```bash
   pnpm exec prisma migrate status
   ```

#### Emergency Rollback (Deploy Previous App Version)

If you need to roll back the application code immediately and the migration cannot be reversed with a follow-up migration (e.g., a forward-only migration has already run):

1. **Redeploy the previous app version** from the last green release tag.
2. **Disable the affected code path** with a feature flag if the new schema cannot be read by the old code.
3. **Do not revert migrations against production data** unless you have verified that no writes have occurred against the new columns/tables.
4. Open a hotfix issue to adapt the code to the current schema.

> [!IMPORTANT]
> Never run `prisma migrate reset` or `prisma migrate dev` against a production database. These commands are designed for local development only.

---

## 3. Irreversible Migrations

Some schema changes cannot be cleanly reversed without data loss. These are called **forward-only** or **irreversible** migrations.

### Examples of Irreversible Operations

| Operation                           | Why It Is Irreversible                                                                 |
| ----------------------------------- | -------------------------------------------------------------------------------------- |
| `DROP COLUMN`                       | The column and its data are permanently removed (unless backed up beforehand).         |
| `DROP TABLE`                        | The entire table and all its data are removed.                                         |
| `ALTER COLUMN ... TYPE` (narrowing) | Changing `TEXT` to `VARCHAR(100)` truncates data; the original longer values are lost. |
| `ALTER COLUMN ... SET NOT NULL`     | If rows with NULL exist and are deleted during migration, that data is unrecoverable.  |
| `RENAME COLUMN` / `RENAME TABLE`    | Old references in code or other migrations may break silently.                         |
| Adding a `UNIQUE` constraint        | If duplicate values exist, the migration fails. Rolling back does not restore them.    |

### How to Handle Irreversible Migrations

1. **Write a backup script first:**

   ```bash
   pg_dump "$DATABASE_URL" \
     -t target_table \
     --column-inserts \
     --data-only \
     > backup_target_table_$(date +%Y%m%d).sql
   ```

2. **Make the migration reversible in two phases where possible:**
   - **Phase 1 (additive):** Add the new column/table as nullable. Deploy and let the application write to both old and new locations.
   - **Phase 2 (destructive):** After confirming no code reads the old structure, drop it in a follow-up release.

3. **Document the irreversible migration in the migration SQL file as a SQL comment:**

   ```sql
   -- IRREVERSIBLE: Drops the legacy `balance` column.
   -- Data in this column will be permanently lost.
   -- Backup: see operations runbook at docs/ops/backup-balance-column.md
   ALTER TABLE creator DROP COLUMN IF EXISTS balance;
   ```

4. **Flag it in the release notes** so operators are aware before deploying.

### Checklist Before Any Irreversible Migration

- [ ] Production data backed up (table-level dump).
- [ ] Irreversible operation documented in the migration SQL file.
- [ ] Release notes call out the irreversible change.
- [ ] Rollback plan documented in the release PR.
- [ ] Feature flag exists to disable the code path depending on the new schema (if applicable).

---

## 4. Migration Workflow Quick Reference

### Creating a New Migration

```bash
# 1. Edit the Prisma schema files in prisma/schema/
# 2. Generate the migration
pnpm exec prisma migrate dev --name short_description_of_change
# 3. Review the generated SQL in prisma/schema/migrations/<timestamp>_<name>/migration.sql
# 4. Run tests
pnpm test
```

### Applying Pending Migrations

```bash
pnpm exec prisma migrate deploy
```

### Checking Migration State

```bash
pnpm exec prisma migrate status
```

### Visualizing the Migration History

```bash
pnpm exec prisma migrate diff \
  --from-migrations prisma/schema/migrations \
  --to-schema-datamodel prisma/schema \
  --script
```

---

## 5. Best Practices

- **One conceptual change per migration.** Avoid bundling unrelated schema changes in a single migration file. This makes rollbacks and code reviews easier.
- **Review the generated SQL** before applying it. Prisma generates correct SQL in most cases, but always verify that the `migration.sql` file matches your intent.
- **Test migrations against a staging database** before deploying to production.
- **Keep migrations under version control.** All migration directories inside `prisma/schema/migrations/` should be committed to Git. Never delete committed migration directories.
- **Ensure forward compatibility.** New columns should be nullable or have a safe default so a partial rollout does not break older application replicas.
- **Use migration checksums.** Prisma tracks a SHA-256 checksum for each migration. If the migration SQL file is modified after being applied, Prisma will detect the checksum mismatch and refuse to proceed. If you must modify an already-applied migration, use `prisma migrate resolve` to reconcile the checksum.

---

## 6. Related Documentation

- [Release Checklist](./release-checklist.md) — Pre-deploy checks for migrations.
- [Configuration Guide](./configuration.md) — Database connection configuration.
- [Read-Model Rebuild](./read-model-rebuild.md) — Rebuilding derived read models after schema changes.
