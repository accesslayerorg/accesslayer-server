// src/modules/creators/creator-public-profile.service.ts
// Service layer for public creator profile endpoints (#1009).

import { prisma } from '../../utils/prisma.utils';
import { encodeCursor, decodeCursor } from '../../utils/cursor.utils';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';

const DEFAULT_KEYS_PAGE_SIZE = 20;
const MAX_KEYS_PAGE_SIZE = 100;
const PROFILE_CACHE_TTL_SECONDS = 300; // 5 minutes
const PROFILE_CACHE_PREFIX = 'creator-public-profile:v1:';

export interface CreatorPublicProfileStats {
   totalHolders: number;
   totalTradingVolume: string;
   followersCount: number;
}

export interface CreatorPublicProfileResult {
   wallet: string;
   memberSince: string;
   totalKeys: number;
   totalVolume: string;
   avgRating: number;
   isVerified: boolean;
   handle: string | null;
   displayName: string | null;
   bio: string | null;
   avatarUrl: string | null;
   stats: CreatorPublicProfileStats;
}

export interface CreatorDeployedKeyItem {
   id: string;
   handle: string;
   displayName: string;
   bio: string | null;
   avatarUrl: string | null;
   isVerified: boolean;
   holderCount: number;
   totalTradingVolume: string;
   status: string;
   price: string;
   createdAt: string;
}

interface DeployedKeysCursor {
   id: string;
   createdAt: string;
}

export interface CreatorDeployedKeysPage {
   items: CreatorDeployedKeyItem[];
   nextCursor: string | null;
   hasMore: boolean;
   limit: number;
   stats: {
      totalKeys: number;
      totalHolders: number;
      totalTradingVolume: string;
   };
}

/**
 * Resolves creator profiles and stellar wallet for a given wallet address.
 */
async function resolveWalletProfiles(wallet: string) {
   const stellarWallet = await prisma.stellarWallet.findUnique({
      where: { address: wallet },
      select: { createdAt: true, userId: true },
   });

   const profiles = await prisma.creatorProfile.findMany({
      where: {
         OR: [
            ...(stellarWallet ? [{ userId: stellarWallet.userId }] : []),
            { id: wallet },
            { handle: wallet },
            { user: { stellarWallet: { address: wallet } } },
         ],
      },
      select: {
         id: true,
         userId: true,
         handle: true,
         displayName: true,
         bio: true,
         avatarUrl: true,
         avatarCid: true,
         twitter: true,
         website: true,
         discord: true,
         isVerified: true,
         tradingPaused: true,
         deprecatedAt: true,
         followersCount: true,
         createdAt: true,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
   });

   const kycRecord = await prisma.kycRecord.findUnique({
      where: { walletAddress: wallet },
      select: { status: true },
   });

   if (!stellarWallet && profiles.length === 0) {
      return null;
   }

   const isVerified =
      (kycRecord && kycRecord.status.toUpperCase() === 'APPROVED') ||
      profiles.some(p => p.isVerified);

   return {
      wallet,
      stellarWallet,
      profiles,
      isVerified,
   };
}

export async function getCreatorPublicProfile(
   wallet: string
): Promise<CreatorPublicProfileResult | null> {
   const cacheKey = `${PROFILE_CACHE_PREFIX}${wallet}`;
   const cached = await cacheGetJson<CreatorPublicProfileResult>(cacheKey);
   if (cached) {
      return cached;
   }

   const resolved = await resolveWalletProfiles(wallet);
   if (!resolved) return null;

   const { profiles, isVerified } = resolved;
   const creatorIds = profiles.map(p => p.id);

   let totalHolders = 0;
   let totalTradingVolume = 0n;
   let totalFollowers = 0;
   let totalScore = 0;

   if (creatorIds.length > 0) {
      const [holderCount, trades, reputations] = await Promise.all([
         prisma.keyOwnership.count({
            where: { creatorId: { in: creatorIds }, balance: { gt: 0 } },
         }),
         prisma.trade.findMany({
            where: { creatorId: { in: creatorIds } },
            select: { price: true, quantity: true },
         }),
         prisma.creatorReputation.findMany({
            where: { creatorId: { in: creatorIds } },
            select: { currentScore: true },
         }),
      ]);

      totalHolders = holderCount;
      for (const trade of trades) {
         try {
            totalTradingVolume +=
               BigInt(trade.price) * BigInt(Math.trunc(Number(trade.quantity)));
         } catch {
            // skip
         }
      }
      for (const rep of reputations) {
         totalScore += rep.currentScore;
      }
      for (const p of profiles) {
         totalFollowers += p.followersCount;
      }
   }

   const avgRating =
      creatorIds.length > 0
         ? Number(((totalScore / creatorIds.length) / 200).toFixed(1))
         : 0;
   const clampedRating = Math.min(5.0, Math.max(0.0, avgRating));

   const dates = [
      resolved.stellarWallet?.createdAt,
      ...profiles.map(p => p.createdAt),
   ].filter(Boolean) as Date[];
   const memberSince =
      dates.length > 0
         ? new Date(Math.min(...dates.map(d => d.getTime()))).toISOString()
         : new Date().toISOString();

   const primaryProfile = profiles[0] || null;

   const result: CreatorPublicProfileResult = {
      wallet,
      memberSince,
      totalKeys: profiles.length,
      totalVolume: totalTradingVolume.toString(),
      avgRating: clampedRating,
      isVerified,
      handle: primaryProfile?.handle ?? null,
      displayName: primaryProfile?.displayName ?? null,
      bio: primaryProfile?.bio ?? null,
      avatarUrl: primaryProfile?.avatarUrl ?? null,
      stats: {
         totalHolders,
         totalTradingVolume: totalTradingVolume.toString(),
         followersCount: totalFollowers,
      },
   };

   await cacheSetJson(cacheKey, result, PROFILE_CACHE_TTL_SECONDS);
   return result;
}

export async function getCreatorDeployedKeys(
   wallet: string,
   rawLimit?: string,
   rawCursor?: string
): Promise<CreatorDeployedKeysPage | null> {
   const resolved = await resolveWalletProfiles(wallet);
   if (!resolved) return null;

   const requestedLimit =
      rawLimit === undefined ? DEFAULT_KEYS_PAGE_SIZE : Number(rawLimit);
   if (
      !Number.isInteger(requestedLimit) ||
      requestedLimit < 1 ||
      requestedLimit > MAX_KEYS_PAGE_SIZE
   ) {
      throw new Error('Invalid keys pagination limit');
   }

   let cursor: DeployedKeysCursor | undefined;
   if (rawCursor !== undefined) {
      try {
         const decoded = decodeCursor<DeployedKeysCursor>(rawCursor);
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

   const userId = resolved.stellarWallet?.userId;
   const profileIds = resolved.profiles.map(p => p.id);

   if (profileIds.length === 0 && !userId) {
      return {
         items: [],
         nextCursor: null,
         hasMore: false,
         limit: requestedLimit,
         stats: { totalKeys: 0, totalHolders: 0, totalTradingVolume: '0' },
      };
   }

   // Fetch keys in deployment order (oldest first: createdAt asc, id asc)
   const profiles = await prisma.creatorProfile.findMany({
      where: {
         ...(userId ? { userId } : { id: { in: profileIds } }),
         ...(cursor
            ? {
                 OR: [
                    { createdAt: { gt: new Date(cursor.createdAt) } },
                    {
                       createdAt: new Date(cursor.createdAt),
                       id: { gt: cursor.id },
                    },
                 ],
              }
            : {}),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: requestedLimit + 1,
      select: {
         id: true,
         handle: true,
         displayName: true,
         bio: true,
         avatarUrl: true,
         isVerified: true,
         tradingPaused: true,
         deprecatedAt: true,
         createdAt: true,
      },
   });

   const hasMore = profiles.length > requestedLimit;
   const pageProfiles = hasMore ? profiles.slice(0, requestedLimit) : profiles;

   const items: CreatorDeployedKeyItem[] = await Promise.all(
      pageProfiles.map(async p => {
         const [holderCount, trades, priceSnapshot] = await Promise.all([
            prisma.keyOwnership.count({
               where: { creatorId: p.id, balance: { gt: 0 } },
            }),
            prisma.trade.findMany({
               where: { creatorId: p.id },
               select: { price: true, quantity: true },
            }),
            prisma.creatorPriceSnapshot.findUnique({
               where: { creatorId: p.id },
               select: { currentPrice: true },
            }),
         ]);

         let totalTradingVolume = 0n;
         for (const trade of trades) {
            try {
               totalTradingVolume +=
                  BigInt(trade.price) * BigInt(Math.trunc(Number(trade.quantity)));
            } catch {
               // skip
            }
         }

         const status = p.deprecatedAt
            ? 'DEPRECATED'
            : p.tradingPaused
            ? 'PAUSED'
            : 'ACTIVE';
         const price = priceSnapshot ? priceSnapshot.currentPrice.toString() : '0';

         return {
            id: p.id,
            handle: p.handle,
            displayName: p.displayName,
            bio: p.bio,
            avatarUrl: p.avatarUrl,
            isVerified: p.isVerified,
            holderCount,
            totalTradingVolume: totalTradingVolume.toString(),
            status,
            price,
            createdAt: p.createdAt.toISOString(),
         };
      })
   );

   const allProfiles = await prisma.creatorProfile.findMany({
      where: userId ? { userId } : { id: { in: profileIds } },
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
            // skip
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
