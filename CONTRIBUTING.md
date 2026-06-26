# Contributing to Access Layer Server

Thanks for contributing to the backend for Access Layer, a Stellar-native creator keys marketplace.

## Before you start

- Read the [README](./README.md) for context.
- Review the [Backend Domain Model and Endpoint Boundaries](./docs/architecture/domain-boundaries.md).
- Review the [Creator Data Model Reference](./docs/architecture/creator-data-model.md) for field types and constraints.
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

## Writing Integration Tests

When adding new endpoints, you must include an integration test that exercises the full request lifecycle against a database.

### Folder Structure and Naming
Integration tests belong in the `src/__tests__/integration/` directory (for cross-module tests) or adjacent to the controller they test (e.g., `src/modules/creators/creators.integration.test.ts`). They must be suffixed with `.test.ts` or `.integration.test.ts`.

### Seeding the Database
Use Prisma to seed test fixtures in a `beforeAll` block, and ensure you clean them up in an `afterAll` block to maintain a pristine test environment. Do not rely on external seed scripts for unit or integration tests.

### Minimal Worked Example

```typescript
import supertest from 'supertest';
import app from '../../app';
import { prisma } from '../../utils/prisma.utils';

describe('GET /api/v1/example', () => {
  beforeAll(async () => {
    // 1. Seed database with test fixtures
    await prisma.user.create({
      data: {
        id: 'test-user',
        email: 'test@example.com',
        passwordHash: 'hash',
        firstName: 'Test',
        lastName: 'User'
      }
    });
  });

  afterAll(async () => {
    // 2. Clean up fixtures
    await prisma.user.delete({ where: { id: 'test-user' } });
    await prisma.$disconnect();
  });

  it('returns 200 and data for an existing record', async () => {
    // 3. Execute the request
    const res = await supertest(app).get('/api/v1/example/test-user');
    
    // 4. Assert response
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
```

### Running Integration Tests Locally
To run only the integration tests, you can use jest with a path or name filter:
```bash
pnpm test -- src/__tests__/integration
# or run a specific file
pnpm test -- creator-holders-404.test.ts
```

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
