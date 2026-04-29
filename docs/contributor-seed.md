# Local seed and fixture guide

A clean clone needs three users plus their wallets and creator profiles to
exercise most flows (creator list, profile read, ownership-gated update).
The repo ships an idempotent seed script that creates exactly that state so
contributors do not need to copy production-like data.

## What gets seeded

The script creates three deterministic users:

| Email                        | Wallet address   | Creator handle | Notes                                                                                          |
| ---------------------------- | ---------------- | -------------- | ---------------------------------------------------------------------------------------------- |
| `alice.creator@example.test` | `GA7XLM…ALICE`   | `alice`        | Verified creator. Use for happy-path creator profile tests.                                    |
| `bob.creator@example.test`   | `GA7XLM…BOB00`   | `bob`          | Unverified creator. Useful for permission and verification flows.                              |
| `charlie.fan@example.test`   | `GA7XLM…CHARLIE` | `charlie`      | Fan account (still has a creator profile). Use as the "wrong wallet" in ownership-gated tests. |

All three share the password `localdev-password-1` (use this in any auth
flow that requires a password). The wallet addresses are obviously fake
placeholders — they keep the database happy without colliding with real
Stellar accounts.

## Running the seed

The seed file is at [`prisma/seed.ts`](../prisma/seed.ts) and is **idempotent**:
re-running it updates existing rows instead of failing on the unique
constraints.

```sh
# Bring the local Postgres container up
pnpm db:up

# Apply migrations
pnpm migrate

# Generate the Prisma client
pnpm generate

# Run the seed
pnpm exec ts-node prisma/seed.ts
```

If you want Prisma to call the seed automatically on `prisma migrate reset`,
add this to `package.json`:

```jsonc
"prisma": {
  "schema": "./prisma/schema",
  "seed": "ts-node prisma/seed.ts"
}
```

## Resetting and re-seeding

The fastest way to a known-good state is `prisma migrate reset`, which drops
the schema, re-applies migrations, and runs the seed (when the hook above is
in place):

```sh
pnpm exec prisma migrate reset --force
```

Without the hook, do it in two steps:

```sh
pnpm exec prisma migrate reset --force --skip-seed
pnpm exec ts-node prisma/seed.ts
```

## Adding fixtures for a new flow

When you ship a feature that needs new fixture data:

1. Add the row(s) to `SEED_USERS` (or a new typed array if the shape
   differs) in [`prisma/seed.ts`](../prisma/seed.ts).
2. Use `upsert` with a stable unique key so re-runs stay idempotent.
3. Document any new account in this file's table.
4. Avoid real PII — `*.test` emails and synthetic wallet addresses are fine.

## Common scenarios

- **Test the creator list endpoint:**
  `GET /api/v1/creators` returns Alice and Bob (Charlie's profile is also
  included since the seed gives every user a creator profile).
- **Test ownership-gated profile update:**
  `PUT /api/v1/creators/alice/profile` with header
  `x-wallet-address: GA7XLM…ALICE` succeeds; the same request with
  `x-wallet-address: GA7XLM…CHARLIE` returns `403 FORBIDDEN`.
- **Test wallet-not-mapped path:**
  Send any request with a wallet address that is not in `SEED_USERS` —
  ownership middleware returns `401 UNAUTHORIZED`.
