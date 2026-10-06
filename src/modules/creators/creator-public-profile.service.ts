// src/modules/creators/creator-public-profile.service.ts
// Service layer for public creator profile endpoints (#900).

import { prisma } from '../../utils/prisma.utils';
import { encodeCursor, decodeCursor } from '../../utils/cursor.utils';

const DEFAULT_KEYS_PAGE_SIZE = 20;
const MAX_KEYS_PAGE_SIZE = 100;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CreatorPublicSocialStats {
   /** Number of unique wallets currently holding keys with balance > 0. */
   totalHolders: number;
   /** Aggregated trading volume (sum of price * quantity) in stroops, as string. */
   totalTradingVolume: string;
   /** Number of followers for this creator profile. */
   followersCount: number;
}

export interface CreatorPublicProfileWithStats {
   id: string;
   handle: string;
   displayName: string;
   bio: string | null;
   avatarUrl: string | null;
   isVerified: boolean;
   createdAt: string;
   updatedAt: string;
   stats: CreatorPublicSocialStats;
}

export interface CreatorIssuedKey {
   id: string;
   handle: string;
   displayName: string;
   bio: string | null;
   avatarUrl: string | null;
   isVerified: boolean;
   holderCount: number;
   totalTradingVolume: string;
   createdAt: string;
}

interface IssuedKeysCursor {
   id: string;
   createdAt: string;
}

export interface CreatorIssuedKeysPage {
   items: CreatorIssuedKey[];
   nextCursor: string | null;
   hasMore: boolean;
   limit: number;
   /** Aggregate stats across all keys for this creator (regardless of page). */
   stats: {
      totalKeys: number;
      totalHolders: number;
      totalTradingVolume: string;
   };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Resolves a creator profile by ID or handle.
 * Returns null when not found.
 */
async function resolveCreatorProfile(
   creatorId: string
): Promise<{ id: string; handle: string; displayName: string; bio: string | null; avatarUrl: string | null; isVerified: boolean; followersCount: number; createdAt: Date; updatedAt: Date } | null> {
   return prisma.creatorProfile.findFirst({
      where: { OR: [{ id: creatorId }, { handle: creatorId }] },
      select: {
         id: true,
         handle: true,
         displayName: true,
         bio: true,
         avatarUrl: true,
         isVerified: true,
         followersCount: true,
         createdAt: true,
         updatedAt: true,
      },
   });
}

/**
 * Computes holder count and total trading volume for a given creator profile ID.
 */
async function computeCreatorKeyStats(
   creatorProfileId: string
): Promise<{ holderCount: number; totalTradingVolume: bigint }> {
   const [holderCount, trades] = await Promise.all([
      prisma.keyOwnership.count({
         where: { creatorId: creatorProfileId, balance: { gt: 0 } },
      }),
      prisma.trade.findMany({
         where: { creatorId: creatorProfileId },
         select: { price: true, quantity: true },
      }),
   ]);

   let totalTradingVolume = 0n;
   for (const trade of trades) {
      try {
         totalTradingVolume +=
            BigInt(trade.price) * BigInt(Math.trunc(Number(trade.quantity)));
      } catch {
         // Skip malformed rows
      }
   }

   return { holderCount, totalTradingVolume };
}

// ── Public service functions ──────────────────────────────────────────────────

/**
 * Returns the public profile for a creator including social stats.
 *
 * Resolves by creator ID or handle. Returns null when the creator does not
 * exist so callers can send a 404.
 */
export async function getCreatorPublicProfile(
   creatorId: string
): Promise<CreatorPublicProfileWithStats | null> {
   const profile = await resolveCreatorProfile(creatorId);
   if (!profile) return null;

   const { holderCount, totalTradingVolume } =
      await computeCreatorKeyStats(profile.id);

   return {
      id: profile.id,
      handle: profile.handle,
      displayName: profile.displayName,
      bio: profile.bio,
      avatarUrl: profile.avatarUrl,
      isVerified: profile.isVerified,
      createdAt: profile.createdAt.toISOString(),
      updatedAt: profile.updatedAt.toISOString(),
      stats: {
         totalHolders: holderCount,
         totalTradingVolume: totalTradingVolume.toString(),
         followersCount: profile.followersCount,
      },
   };
}

/**
 * Returns a cursor-paginated list of keys (CreatorProfile records) issued by
 * the same user who owns the given creator profile, together with aggregate
 * stats across all keys.
 *
 * Resolves the creator by ID or handle first. Returns null when the creator
 * does not exist.
 */
export async function getCreatorIssuedKeys(
   creatorId: string,
   rawLimit?: string,
   rawCursor?: string
): Promise<CreatorIssuedKeysPage | null> {
   // 1. Resolve the creator profile to get userId
   const profile = await prisma.creatorProfile.findFirst({
      where: { OR: [{ id: creatorId }, { handle: creatorId }] },
      select: { id: true, userId: true },
   });
   if (!profile) return null;

   // 2. Validate and parse the page size
   const requestedLimit =
      rawLimit === undefined ? DEFAULT_KEYS_PAGE_SIZE : Number(rawLimit);
   if (
      !Number.isInteger(requestedLimit) ||
      requestedLimit < 1 ||
      requestedLimit > MAX_KEYS_PAGE_SIZE
   ) {
      throw new Error('Invalid keys pagination limit');
   }

   // 3. Decode the cursor when provided
   let cursor: IssuedKeysCursor | undefined;
   if (rawCursor !== undefined) {
      try {
         const decoded = decodeCursor<IssuedKeysCursor>(rawCursor);
         if (
            typeof decoded.id !== 'string' ||
            !decoded.id ||
            typeof decoded.createdAt !== 'string' ||
            Number.isNaN(Date.parse(decoded.createdAt))
         ) {
            throw new Error('Invalid cursor payload');
         }
         cursor = decoded;
      } catch {
         throw new Error('Invalid keys pagination cursor');
      }
   }

   // 4. Fetch page: all CreatorProfile records belonging to the same user
   const profiles = await prisma.creatorProfile.findMany({
      where: {
         userId: profile.userId,
         ...(cursor
            ? {
                 OR: [
                    { createdAt: { lt: new Date(cursor.createdAt) } },
                    {
                       createdAt: new Date(cursor.createdAt),
                       id: { lt: cursor.id },
                    },
                 ],
              }
            : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: requestedLimit + 1,
      select: {
         id: true,
         handle: true,
         displayName: true,
         bio: true,
         avatarUrl: true,
         isVerified: true,
         createdAt: true,
      },
   });

   const hasMore = profiles.length > requestedLimit;
   const pageProfiles = hasMore ? profiles.slice(0, requestedLimit) : profiles;

   // 5. Compute per-key stats in parallel
   const items: CreatorIssuedKey[] = await Promise.all(
      pageProfiles.map(async p => {
         const { holderCount, totalTradingVolume } =
            await computeCreatorKeyStats(p.id);
         return {
            id: p.id,
            handle: p.handle,
            displayName: p.displayName,
            bio: p.bio,
            avatarUrl: p.avatarUrl,
            isVerified: p.isVerified,
            holderCount,
            totalTradingVolume: totalTradingVolume.toString(),
            createdAt: p.createdAt.toISOString(),
         };
      })
   );

   // 6. Compute aggregate stats across ALL keys for this user (not just this page)
   const allProfiles = await prisma.creatorProfile.findMany({
      where: { userId: profile.userId },
      select: { id: true },
   });
   const allIds = allProfiles.map(p => p.id);

   let totalHolders = 0;
   let totalTradingVolume = 0n;

   if (allIds.length > 0) {
      const [holderCount, trades] = await Promise.all([
         prisma.keyOwnership.count({
            where: { creatorId: { in: allIds }, balance: { gt: 0 } },
         }),
         prisma.trade.findMany({
            where: { creatorId: { in: allIds } },
            select: { price: true, quantity: true },
         }),
      ]);
      totalHolders = holderCount;
      for (const trade of trades) {
         try {
            totalTradingVolume +=
               BigInt(trade.price) * BigInt(Math.trunc(Number(trade.quantity)));
         } catch {
            // Skip malformed rows
         }
      }
   }

   const lastItem = pageProfiles[pageProfiles.length - 1];

   return {
      items,
      nextCursor:
         hasMore && lastItem
            ? encodeCursor({
                 id: lastItem.id,
                 createdAt: lastItem.createdAt.toISOString(),
              })
            : null,
      hasMore,
      limit: requestedLimit,
      stats: {
         totalKeys: allIds.length,
         totalHolders,
         totalTradingVolume: totalTradingVolume.toString(),
      },
   };
}
