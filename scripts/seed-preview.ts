// scripts/seed-preview.ts
// Deterministic seed data for per-pull-request preview environments (#1340).
//
// Safety: the script refuses to run unless DATABASE_URL selects a preview
// schema (`?schema=preview_...`). It must never seed a shared database.
//
// Usage (CI runs this after `prisma migrate deploy`):
//   DATABASE_URL="postgresql://...?schema=preview_pr_123" \
//     pnpm exec ts-node --transpile-only scripts/seed-preview.ts

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const PREVIEW_SCHEMA_PATTERN = /[?&]schema=preview_[a-z0-9_]+/;

interface PreviewCreator {
   email: string;
   firstName: string;
   lastName: string;
   handle: string;
   displayName: string;
   bio: string;
   walletAddress: string;
   isVerified: boolean;
   priceStroops: bigint;
}

// Addresses are obviously synthetic (fixed padding) so they cannot be mistaken
// for real accounts. Prices are fixed so the mock oracle output is repeatable.
const PREVIEW_CREATORS: PreviewCreator[] = [
   {
      email: 'preview.alice@example.test',
      firstName: 'Alice',
      lastName: 'Preview',
      handle: 'preview-alice',
      displayName: 'Alice Preview',
      bio: 'Seeded creator for preview environments.',
      walletAddress: 'GPREVIEW00000000000000000000000000000000000000000000ALICE',
      isVerified: true,
      priceStroops: BigInt(1_000_000),
   },
   {
      email: 'preview.bob@example.test',
      firstName: 'Bob',
      lastName: 'Preview',
      handle: 'preview-bob',
      displayName: 'Bob Preview',
      bio: 'Second seeded creator for trade and ownership checks.',
      walletAddress: 'GPREVIEW00000000000000000000000000000000000000000000BOBBY',
      isVerified: false,
      priceStroops: BigInt(2_500_000),
   },
];

export function assertPreviewDatabase(databaseUrl: string | undefined): string {
   if (!databaseUrl) {
      throw new Error('DATABASE_URL is required');
   }
   if (!PREVIEW_SCHEMA_PATTERN.test(databaseUrl)) {
      throw new Error(
         'Refusing to seed: DATABASE_URL must select a preview schema (?schema=preview_...)'
      );
   }
   return databaseUrl;
}

async function main(): Promise<void> {
   assertPreviewDatabase(process.env.DATABASE_URL);
   const prisma = new PrismaClient();

   try {
      // Fixed password for throwaway preview accounts only.
      const passwordHash = await bcrypt.hash('preview-only-password', 10);

      for (const creator of PREVIEW_CREATORS) {
         const user = await prisma.user.upsert({
            where: { email: creator.email },
            create: {
               email: creator.email,
               firstName: creator.firstName,
               lastName: creator.lastName,
               passwordHash,
               emailVerified: true,
               emailVerifiedAt: new Date(),
            },
            update: { firstName: creator.firstName, lastName: creator.lastName },
         });

         await prisma.stellarWallet.upsert({
            where: { userId: user.id },
            create: { userId: user.id, address: creator.walletAddress },
            update: { address: creator.walletAddress },
         });

         const profile = await prisma.creatorProfile.upsert({
            where: { userId: user.id },
            create: {
               userId: user.id,
               handle: creator.handle,
               displayName: creator.displayName,
               bio: creator.bio,
               isVerified: creator.isVerified,
            },
            update: {
               handle: creator.handle,
               displayName: creator.displayName,
               bio: creator.bio,
               isVerified: creator.isVerified,
            },
         });

         await prisma.creatorPriceSnapshot.upsert({
            where: { creatorId: profile.id },
            create: {
               creatorId: profile.id,
               currentPrice: creator.priceStroops,
               price24hAgo: creator.priceStroops,
               lastTradeAt: new Date('2026-01-01T00:00:00Z'),
            },
            update: {},
         });

         console.log(`seeded ${creator.handle}`);
      }
   } finally {
      await prisma.$disconnect();
   }
}

if (require.main === module) {
   main().catch(error => {
      console.error('preview seed failed:', error);
      process.exit(1);
   });
}
