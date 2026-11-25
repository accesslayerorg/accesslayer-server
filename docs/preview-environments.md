# Preview Environments

Each pull request from a branch in this repository gets its own stack: an app deployment, a
database schema with migrations applied, and seeded data. Reviewers can click a link instead
of running the branch locally. The workflow is [`.github/workflows/preview.yml`](../.github/workflows/preview.yml).

## Lifecycle

| Event | What happens |
| --- | --- |
| PR opened, reopened or updated | Schema `preview_pr_<n>` is created, migrated and seeded. The deploy hook deploys the stack. The health check runs. The PR gets the `preview` label and a comment with the URL and health status. |
| Push to the PR | The same schema and deployment are updated. The same comment is edited in place. |
| PR closed | The schema is dropped with `CASCADE`. The deploy hook removes the deployment. The label and comment are updated. |
| Daily sweep (04:17 UTC) | Previews for closed PRs are removed. Previews with no activity for 7 days are removed. |

Fork pull requests do not get a preview. They receive no secrets, so the deploy and teardown
jobs skip them. Maintainers can open a branch in the main repository to test a fork's changes.

## Cost controls

- At most `MAX_CONCURRENT_PREVIEWS` previews run at once (repository variable, default `5`).
  A new PR over the limit gets a comment saying so and no deployment. Close an older preview PR
  or raise the variable.
- Every preview expires after 7 days without activity.
- Concurrency per PR is serialised: a push waits for the previous run instead of racing it.

## Configuration

Set these in the repository settings. The workflow uses the `preview` environment, so you can
add protection rules there (required reviewers, deployment branches).

| Name | Kind | Purpose |
| --- | --- | --- |
| `PREVIEW_DATABASE_ADMIN_URL` | secret | Postgres URL without `schema=`, with rights to create and drop schemas on the shared preview database |
| `PREVIEW_DEPLOY_HOOK_URL` | secret | Endpoint on the staging cluster that deploys and tears down preview stacks |
| `PREVIEW_DEPLOY_TOKEN` | secret | Bearer token for the deploy hook |
| `PREVIEW_SOROBAN_RPC_URL` | variable | Shared test network RPC for previews |
| `PREVIEW_ORACLE_MODE` | variable | Defaults to `mock` for deterministic prices |
| `MAX_CONCURRENT_PREVIEWS` | variable | Defaults to `5` |

### Deploy hook contract

`scripts/preview/preview-env.mjs` calls the hook with `POST` and a JSON body:

```json
{ "action": "deploy", "pr": 123, "sha": "<head sha>", "schema": "preview_pr_123",
  "env": { "SOROBAN_RPC_URL": "…", "ORACLE_MODE": "mock" } }
```

The hook replies `200` with `{ "url": "https://…" }`. Teardown posts `{ "action": "teardown", "pr", "schema" }`.

The hook never receives database credentials. It must look up the connection string for
`preview_pr_<n>` from the cluster's own secret store. This keeps the admin URL out of the
deployment platform.

## What is seeded

[`scripts/seed-preview.ts`](../scripts/seed-preview.ts) creates two creators with fixed
synthetic wallet addresses and fixed prices. It refuses to run unless `DATABASE_URL` selects a
`preview_` schema, so it cannot seed a shared database.

## Debugging a failed preview

1. **Open the run log.** The `Provision, migrate, seed and deploy` step shows which stage failed.
2. **Schema or migration failure.** Run `prisma migrate deploy` against the same schema locally,
   using `DATABASE_URL="<admin url>?schema=preview_pr_<n>"`. A migration that fails only on previews
   usually means it depends on data that the seed does not create.
3. **Seed failure.** Check the `scripts/seed-preview.ts` output. A new unique field or a required
   column in the schema is the usual cause.
4. **Deploy hook error.** The hook returned a non-200 status. The step output includes the status
   code, never the body or credentials. Check the staging cluster's deployment logs for `pr` and `schema`.
5. **Unhealthy.** The comment shows the last health result. The deployment is still up.
   Open `<url>/api/v1/health` and check the app logs for the `pr` tag.
6. **Manual cleanup.** If a teardown step failed, run the sweep manually from the Actions tab
   (`workflow_dispatch`), or run `node scripts/preview/preview-env.mjs teardown --pr <n>` with the
   same environment variables.
7. **Limit reached.** Close another preview PR, or raise `MAX_CONCURRENT_PREVIEWS`.

## Not covered yet

- The deploy hook and the staging cluster are not defined in this repository. Maintainers must
  provide the endpoint that implements the contract above.
- The mock oracle is referenced by name only. Wiring `ORACLE_MODE=mock` into the server config is
  a follow-up.
