## Summary

-

## Testing

- [ ] `pnpm lint`
- [ ] `pnpm build`
- [ ] `pnpm exec prisma generate` when schema or generated types changed

## Checklist

- [ ] Linked issue or backlog item
- [ ] No secrets or live credentials added
- [ ] Docs updated if setup or env changed
- [ ] Change is scoped to one problem

## Schema changes

Complete this section only if the PR adds or changes a migration under `prisma/schema/`. See [docs/migrations.md](../docs/migrations.md).

- [ ] Migration is expand-only (adds columns, tables, or indexes), or the contract step is in a later PR
- [ ] No `DROP COLUMN`, `DROP TABLE`, `ALTER TYPE`, or `RENAME` in this PR, or each one has a `-- migration-safe: <reason>` comment that code owners have reviewed
- [ ] Indexes on existing tables use `CREATE INDEX CONCURRENTLY`
- [ ] `SET lock_timeout` and `SET statement_timeout` are at the top of each new migration
- [ ] The previous app version still runs correctly against the migrated schema
- [ ] `pnpm exec ts-node --transpile-only scripts/check-migrations.ts --base origin/main` passes locally
