# Contributing to Access Layer Server

Thanks for contributing to the backend for Access Layer, a Stellar-native creator keys marketplace.

## Before you start

- Read the [README](./README.md) for context.
- Review the [Backend Domain Model and Endpoint Boundaries](./docs/architecture/domain-boundaries.md).
- Review the scoped backlog in [docs/open-source/issue-backlog.md](./docs/open-source/issue-backlog.md).
- Keep pull requests limited to one backend issue or one documentation improvement.
- Open a discussion before changing core API shape or background processing architecture.

## Local setup

1. Install Node.js 20+ and `pnpm`.
2. Copy `.env.example` to `.env`.
3. Install dependencies:

```bash
pnpm install
```

4. Generate Prisma client:

```bash
pnpm exec prisma generate
```

5. Start the dev server:

```bash
pnpm dev
```

6. (Optional) Seed deterministic local data — three users with wallets and
   creator profiles, sufficient to exercise list, read, and ownership-gated
   write flows:

```bash
pnpm exec ts-node prisma/seed.ts
```

See [docs/contributor-seed.md](./docs/contributor-seed.md) for the full
fixture catalogue, reset workflow, and example requests.

## Verification commands

```bash
pnpm lint
pnpm build
```

Run `pnpm exec prisma generate` again whenever Prisma schema changes.

## Backend contribution rules

- Do not commit secrets, service accounts, or live credentials.
- Use `.env.example` for safe placeholders only.
- Keep API contracts explicit and documented.
- Prefer clear domain names tied to Access Layer, not legacy template modules.
- Add validation and error-handling behavior when introducing new endpoints.

## Good first issue guidance

Good first issues in this repo should:

- avoid production credentials or third-party account dependencies
- have a narrow API or documentation scope
- include acceptance criteria and test instructions
- avoid broad data model refactors

## Questions

If repo boundaries are unclear, confirm whether the work belongs in the client, server, or contracts repository before starting implementation.
