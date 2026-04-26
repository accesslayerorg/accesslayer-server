// prisma/seed.ts
//
// Idempotent seed script for local development. Run from the repo root:
//
//   pnpm exec tsx prisma/seed.ts            # tsx, if installed
//   pnpm exec ts-node prisma/seed.ts        # ts-node fallback
//
// Or wire it into Prisma's seeding hook by adding to package.json:
//
//   "prisma": {
//     "schema": "./prisma/schema",
//     "seed": "ts-node prisma/seed.ts"
//   }
//
// See `docs/contributor-seed.md` for the full setup workflow.

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

interface SeedUser {
   email: string;
   firstName: string;
   lastName: string;
   handle: string;
   displayName: string;
   bio: string;
   walletAddress: string;
   isVerified: boolean;
}

const SEED_USERS: SeedUser[] = [
   {
      email: 'alice.creator@example.test',
      firstName: 'Alice',
      lastName: 'Example',
      handle: 'alice',
      displayName: 'Alice Example',
      bio: 'Verified creator for local development.',
      walletAddress:
         'GA7XLM00000000000000000000000000000000000000000000000ALICE',
      isVerified: true,
   },
   {
      email: 'bob.creator@example.test',
      firstName: 'Bob',
      lastName: 'Example',
      handle: 'bob',
      displayName: 'Bob Example',
      bio: 'Unverified creator for local development.',
      walletAddress:
         'GA7XLM000000000000000000000000000000000000000000000000BOB00',
      isVerified: false,
   },
   {
      email: 'charlie.fan@example.test',
      firstName: 'Charlie',
      lastName: 'Fan',
      handle: 'charlie',
      displayName: 'Charlie Fan',
      bio: 'Fan/holder account for ownership-check testing.',
      walletAddress:
         'GA7XLM0000000000000000000000000000000000000000000000CHARLIE',
      isVerified: false,
   },
];

async function seed() {
   const passwordHash = await bcrypt.hash('localdev-password-1', 10);

   for (const user of SEED_USERS) {
      const upsertedUser = await prisma.user.upsert({
         where: { email: user.email },
         create: {
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
            passwordHash,
            emailVerified: true,
            emailVerifiedAt: new Date(),
         },
         update: {
            firstName: user.firstName,
            lastName: user.lastName,
         },
      });

      await prisma.stellarWallet.upsert({
         where: { userId: upsertedUser.id },
         create: {
            userId: upsertedUser.id,
            address: user.walletAddress,
         },
         update: {
            address: user.walletAddress,
         },
      });

      await prisma.creatorProfile.upsert({
         where: { userId: upsertedUser.id },
         create: {
            userId: upsertedUser.id,
            handle: user.handle,
            displayName: user.displayName,
            bio: user.bio,
            isVerified: user.isVerified,
         },
         update: {
            handle: user.handle,
            displayName: user.displayName,
            bio: user.bio,
            isVerified: user.isVerified,
         },
      });

      console.log(`✓ seeded ${user.email} (${user.handle})`);
   }
}

seed()
   .catch(error => {
      console.error('seed failed:', error);
      process.exit(1);
   })
   .finally(() => prisma.$disconnect());
