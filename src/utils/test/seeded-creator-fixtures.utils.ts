import { CreatorProfile } from '../../types/profile.types';
import type { prisma as appPrisma } from '../prisma.utils';

const CREATOR_FIXTURE_BASE_DATE = new Date(Date.UTC(2020, 0, 1));

type CreatorMarketSeedPrisma = typeof appPrisma;

export interface CreatorMarketSeedOptions {
   prefix?: string;
   displayName?: string;
   isVerified?: boolean;
   createdAt?: Date;
   updatedAt?: Date;
   price?: bigint;
   price24hAgo?: bigint;
   lastTradeAt?: Date | null;
   walletAddress?: string;
   balance?: number | string;
}

export interface SeededCreatorMarketFixture {
   userId: string;
   creatorId: string;
   handle: string;
   displayName: string;
}

/**
 * Generates a deterministic creator record from a numeric seed.
 *
 * Field mapping:
 * - id: `creator-${seed}`
 * - userId: `user-${seed}`
 * - handle: `creator-${seed}`
 * - displayName: `Creator ${seed}`
 * - avatarUrl: `https://example.com/avatar-${seed}.png`
 * - bio: `Bio for creator ${seed}`
 * - perkSummary: `Perks for creator ${seed}`
 * - perks: []
 * - isVerified: true for even seeds, false for odd seeds
 * - createdAt: 2020-01-01 UTC plus `seed` days
 * - updatedAt: `createdAt` plus 1 second
 *
 * This helper is intentionally stable: the same seed always returns the same object,
 * and different seeds produce distinct creator values.
 */
export function createSeededCreatorFixture(
   seed: number,
   overrides: Partial<CreatorProfile> = {}
): CreatorProfile {
   const normalizedSeed = Math.max(0, Math.floor(seed));
   const createdAt = new Date(CREATOR_FIXTURE_BASE_DATE);
   createdAt.setUTCDate(createdAt.getUTCDate() + normalizedSeed);
   const finalCreatedAt = overrides.createdAt ?? createdAt;

   return {
      id: `creator-${normalizedSeed}`,
      userId: `user-${normalizedSeed}`,
      handle: `creator-${normalizedSeed}`,
      displayName: `Creator ${normalizedSeed}`,
      bio: `Bio for creator ${normalizedSeed}`,
      avatarUrl: `https://example.com/avatar-${normalizedSeed}.png`,
      perkSummary: `Perks for creator ${normalizedSeed}`,
      perks: [],
      isVerified: normalizedSeed % 2 === 0,
      createdAt: finalCreatedAt,
      updatedAt:
         overrides.updatedAt ?? new Date(finalCreatedAt.getTime() + 1000),
      ...overrides,
   };
}

function buildMarketSeedIdentity(seed: number, prefix: string): CreatorProfile {
   return createSeededCreatorFixture(seed, {
      id: `${prefix}-creator-${seed}`,
      userId: `${prefix}-user-${seed}`,
      handle: `${prefix}-handle-${seed}`,
      displayName: `${prefix} creator ${seed}`,
   });
}

export async function upsertCreatorPriceSnapshot(
   prisma: CreatorMarketSeedPrisma,
   creatorId: string,
   currentPrice: bigint,
   options: Pick<CreatorMarketSeedOptions, 'price24hAgo' | 'lastTradeAt'> = {}
): Promise<void> {
   const price24hAgo = options.price24hAgo ?? currentPrice;
   const lastTradeAt = options.lastTradeAt ?? new Date();

   await prisma.creatorPriceSnapshot.upsert({
      where: { creatorId },
      create: {
         creatorId,
         currentPrice,
         price24hAgo,
         lastTradeAt,
      },
      update: {
         currentPrice,
         price24hAgo,
         lastTradeAt,
      },
   });
}

export async function upsertCreatorHolding(
   prisma: CreatorMarketSeedPrisma,
   ownerAddress: string,
   creatorId: string,
   balance: number | string
): Promise<void> {
   await prisma.keyOwnership.upsert({
      where: {
         ownerAddress_creatorId: {
            ownerAddress,
            creatorId,
         },
      },
      create: {
         ownerAddress,
         creatorId,
         balance,
      },
      update: {
         balance,
      },
   });
}

export async function seedCreatorMarketFixture(
   prisma: CreatorMarketSeedPrisma,
   seed: number,
   options: CreatorMarketSeedOptions = {}
): Promise<SeededCreatorMarketFixture> {
   const prefix = options.prefix ?? 'creator-market';
   const identity = buildMarketSeedIdentity(seed, prefix);
   const displayName = options.displayName ?? identity.displayName;
   const isVerified = options.isVerified ?? identity.isVerified;

   await prisma.user.upsert({
      where: { id: identity.userId },
      create: {
         id: identity.userId,
         email: `${identity.userId}@example.test`,
         passwordHash: 'dummy-hash',
         firstName: 'Creator',
         lastName: `${prefix} ${seed}`,
      },
      update: {
         email: `${identity.userId}@example.test`,
         passwordHash: 'dummy-hash',
         firstName: 'Creator',
         lastName: `${prefix} ${seed}`,
      },
   });

   const creator = await prisma.creatorProfile.upsert({
      where: { id: identity.id },
      create: {
         id: identity.id,
         userId: identity.userId,
         handle: identity.handle,
         displayName,
         bio: identity.bio,
         avatarUrl: identity.avatarUrl,
         perkSummary: identity.perkSummary,
         perks: identity.perks ?? [],
         isVerified,
         createdAt: options.createdAt ?? identity.createdAt,
         updatedAt: options.updatedAt ?? identity.updatedAt,
      },
      update: {
         handle: identity.handle,
         displayName,
         bio: identity.bio,
         avatarUrl: identity.avatarUrl,
         perkSummary: identity.perkSummary,
         perks: identity.perks ?? [],
         isVerified,
         createdAt: options.createdAt ?? identity.createdAt,
         updatedAt: options.updatedAt ?? identity.updatedAt,
      },
   });

   if (options.price !== undefined) {
      await upsertCreatorPriceSnapshot(prisma, creator.id, options.price, {
         price24hAgo: options.price24hAgo,
         lastTradeAt: options.lastTradeAt,
      });
   }

   if (options.walletAddress !== undefined && options.balance !== undefined) {
      await upsertCreatorHolding(
         prisma,
         options.walletAddress,
         creator.id,
         options.balance
      );
   }

   return {
      userId: identity.userId,
      creatorId: creator.id,
      handle: creator.handle,
      displayName,
   };
}
