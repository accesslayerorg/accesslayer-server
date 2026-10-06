import { prisma } from '../../utils/prisma.utils';
import {
   cacheGetJson,
   cacheInvalidate,
   cacheSetJson,
} from '../../utils/redis.utils';
import { encodeCursor, decodeCursor } from '../../utils/cursor.utils';

const PORTFOLIO_STATS_TTL_SECONDS = 60;
const PORTFOLIO_STATS_CACHE_PREFIX = 'creator-portfolio:stats:v1:';
const DEFAULT_KEYS_PAGE_SIZE = 20;
const MAX_KEYS_PAGE_SIZE = 100;

export interface CreatorPortfolioStats {
   totalKeys: number;
   totalHolders: number;
   totalTradingVolume: string;
}

export interface CreatorPortfolioKey {
   id: string;
   handle: string;
   displayName: string;
   bio: string | null;
   avatarUrl: string | null;
   isVerified: boolean;
   createdAt: Date;
}

interface CreatorKeysCursor {
   id: string;
   createdAt: string;
}

export interface CreatorKeysPage {
   items: CreatorPortfolioKey[];
   nextCursor: string | null;
   hasMore: boolean;
   limit: number;
}

export async function findCreatorPortfolio(wallet: string) {
   const profiles = await prisma.creatorProfile.findMany({
      where: { user: { stellarWallet: { is: { address: wallet } } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
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

   return profiles;
}

export async function getCreatorPortfolioStats(
   wallet: string
): Promise<CreatorPortfolioStats> {
   const cacheKey = `${PORTFOLIO_STATS_CACHE_PREFIX}${wallet}`;
   const cached = await cacheGetJson<CreatorPortfolioStats>(cacheKey);
   if (cached) return cached;

   const profiles = await prisma.creatorProfile.findMany({
      where: { user: { stellarWallet: { is: { address: wallet } } } },
      select: { id: true },
   });
   const creatorIds = profiles.map(profile => profile.id);

   let totalHolders = 0;
   let totalTradingVolume = 0n;
   if (creatorIds.length > 0) {
      const [holderCount, trades] = await Promise.all([
         prisma.keyOwnership.count({
            where: { creatorId: { in: creatorIds }, balance: { gt: 0 } },
         }),
         prisma.activity.findMany({
            where: {
               creatorId: { in: creatorIds },
               type: { in: ['KEY_BOUGHT', 'KEY_SOLD'] },
            },
            select: { payload: true },
         }),
      ]);
      totalHolders = holderCount;

      for (const trade of trades) {
         const payload = trade.payload as Record<string, unknown>;
         if (payload?.amount === undefined || payload?.price_at_trade == null) {
            continue;
         }
         try {
            totalTradingVolume +=
               BigInt(Math.trunc(Number(payload.amount))) *
               BigInt(String(payload.price_at_trade));
         } catch {
            continue;
         }
      }
   }

   const stats = {
      totalKeys: creatorIds.length,
      totalHolders,
      totalTradingVolume: totalTradingVolume.toString(),
   };
   await cacheSetJson(cacheKey, stats, PORTFOLIO_STATS_TTL_SECONDS);
   return stats;
}

export async function fetchCreatorPortfolioKeys(
   wallet: string,
   rawLimit?: string,
   rawCursor?: string
): Promise<CreatorKeysPage> {
   const requestedLimit =
      rawLimit === undefined ? DEFAULT_KEYS_PAGE_SIZE : Number(rawLimit);
   if (
      !Number.isInteger(requestedLimit) ||
      requestedLimit < 1 ||
      requestedLimit > MAX_KEYS_PAGE_SIZE
   ) {
      throw new Error('Invalid keys pagination limit');
   }

   let cursor: CreatorKeysCursor | undefined;
   if (rawCursor !== undefined) {
      try {
         const decoded = decodeCursor<CreatorKeysCursor>(rawCursor);
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

   const profiles = await prisma.creatorProfile.findMany({
      where: {
         user: { stellarWallet: { is: { address: wallet } } },
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
   const items = hasMore ? profiles.slice(0, requestedLimit) : profiles;
   const lastItem = items[items.length - 1];

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
   };
}

export async function invalidateCreatorPortfolioStatsCache(
   wallet: string
): Promise<void> {
   await cacheInvalidate(`${PORTFOLIO_STATS_CACHE_PREFIX}${wallet}`);
}
