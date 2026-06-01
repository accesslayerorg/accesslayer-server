# Backend release checklist

A short, operationally actionable checklist for shipping a backend release
safely. Run through it for every deploy that touches production traffic. Each
item is fast — the goal is fewer broken deploys, not more process.

> **Tip:** copy the markdown into the release PR description, tick boxes as
> you go, and link the resulting PR from the release announcement.

## Pre-deploy

### Repo state

- [ ] `pnpm install` is clean on a fresh clone.
- [ ] `pnpm lint` passes.
- [ ] `pnpm build` passes (catches typos in `tsconfig.json` paths and Prisma
      type drift before runtime).
- [ ] `pnpm exec jest` passes (or the failing suites are documented as
      pre-existing in the release notes).
- [ ] No new `console.log` left over from debugging in production code.

### Configuration

- [ ] `src/config.ts` schema matches the env vars actually set in production.
- [ ] Any new required env var has a placeholder in `.env.example`.
- [ ] Secrets rotation is **not** part of this release (or, if it is, the
      rotation runbook is linked in the release notes).
- [ ] Feature flags or kill switches needed for rollout are wired up and
      default to the safe value.

### Database migrations

- [ ] `pnpm exec prisma migrate diff --from-migrations ./prisma/schema/migrations --to-schema-datamodel ./prisma/schema --script` produces only the diff you intend.
- [ ] No destructive operations (DROP TABLE / DROP COLUMN / ALTER COLUMN
      type-narrow) in the migration. If unavoidable, schedule a separate
      maintenance window and link the runbook here.
- [ ] Migrations are **forward-compatible with the previous app version**
      so a partial rollout does not break the older replicas. Add columns
      as nullable; backfill in a follow-up.
- [ ] Rollback path is documented: which migration to revert and which app
      version to redeploy.

### API / contract changes

- [ ] No breaking changes to existing endpoint shapes. New fields go in
      additively; field removals require a deprecation cycle.
- [ ] Public endpoints have explicit cache-control settings (cf.
      `src/constants/creator-public-cache.constants.ts`).
- [ ] Routes that should be authenticated have a guard middleware applied
      (e.g. `requireCreatorProfileOwnership`, `adminGuard`).
- [ ] OpenAPI / `tspec` definitions still validate (`pnpm validate-api`).

## Rollout

- [ ] Deploy to staging first; smoke-test:
   - `GET /api/v1/health` returns `200`.
   - `GET /api/v1/health/ready` returns `200` (DB reachable, indexer in sync).
   - `GET /api/v1/health/detailed` shows no degraded checks.
   - Hit at least one read path (`GET /api/v1/creators`) and one write path
     (`PUT /api/v1/creators/:creatorId/profile` with a wallet you own).
- [ ] Deploy production with rolling restart; **do not** fast-fail the old
      pods until the new ones report ready.
- [ ] Watch error rate and p95 latency for the first 5 minutes after
      rollout completes. If either rises sharply, roll back without trying
      to diagnose live.

## Post-deploy

- [ ] Verify migrations actually ran: `pnpm exec prisma migrate status`
      in the deployed environment shows no pending migrations.
- [ ] Check `GET /api/v1/health/detailed` shows every dependency healthy.
- [ ] Confirm a representative sample of recent requests in the access log
      look normal (no 5xx spike, no auth blowback).
- [ ] Update the release notes / changelog with the deployed SHA.

## Rollback

- [ ] Re-deploy the previous app version from the last green release tag.
- [ ] If the rollback uncovers a forward-only migration:
   1. Disable the affected code path with the feature flag (if any).
   2. Open a hotfix branch that adapts the new code to the live schema.
   3. **Do not** revert migrations against production data unless it is
      genuinely safe (no writes against the new columns yet).
- [ ] Open a follow-up issue describing what failed and how to prevent it.

## When this checklist needs an update

If you hit something during a deploy that this checklist did not catch,
add it here in the same release PR. The checklist is the documentation of
the lessons we have already learned the hard way.
