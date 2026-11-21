// src/modules/keys/key-leaderboard.service.ts
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { getRedis } from '../../utils/redis.utils';
import { compute24hPriceChange } from '../../utils/price.utils';
import { MAX_PAGE_SIZE } from '../../constants/pagination.constants';

export type KeyLeaderboardSortBy =
   | 'holder_count'
   | 'volume_24h'
   | 'volume_7d'
   | 'price_change';

export interface KeyLeaderboardEntry {
   rank: number;
   keyId: string;
   creatorName: string;
   handle: string;
   avatarUrl: string | null;
   holder_count: number;
   volume_24h: string;
   volume_7d: string;
   price_change: number | null;
   metricValue: number | string;
}

const REDIS_OP_TIMEOUT_MS = 1000;
const CACHE_TTL_SECONDS = 60;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
   return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
         () => reject(new Error(`Redis operation timed out after ${ms}ms`)),
         ms
      );
      promise.then(
         value => {
            clearTimeout(timer);
            resolve(value);
         },
         error => {
            clearTimeout(timer);
            reject(error);
         }
      );
   });
}

export async function computeKeyLeaderboard(
   sortBy: KeyLeaderboardSortBy,
   limit: number
): Promise<KeyLeaderboardEntry[]> {
   const now = Date.now();
   const nowDate = new Date(now);
   const window7dStart = new Date(now - 7 * 24 * 60 * 60 * 1000);
   const window24hStart = new Date(now - 24 * 60 * 60 * 1000);

   const creators = await prisma.creatorProfile.findMany({
      select: {
         id: true,
         handle: true,
         displayName: true,
         avatarUrl: true,
         createdAt: true,
         priceSnapshot: {
            select: { currentPrice: true, price24hAgo: true },
         },
      },
   });

   if (creators.length === 0) {
      return [];
   }

   const creatorIds = creators.map(c => c.id);

   const holderCountsByCreator = new Map<string, number>();
   const holderGroups = await prisma.keyOwnership.groupBy({
      by: ['creatorId'],
      where: {
         creatorId: { in: creatorIds },
         balance: { gt: 0 },
      },
      _count: {
         ownerAddress: true,
      },
   });
   for (const g of holderGroups) {
      holderCountsByCreator.set(g.creatorId, g._count.ownerAddress);
   }

   const activities = await prisma.activity.findMany({
      where: {
         type: { in: ['KEY_BOUGHT', 'KEY_SOLD'] },
         creatorId: { in: creatorIds },
         createdAt: { gte: window7dStart, lte: nowDate },
      },
      select: { creatorId: true, createdAt: true, payload: true },
   });

   const volume24hMap = new Map<string, bigint>();
   const volume7dMap = new Map<string, bigint>();

   for (const activity of activities) {
      if (!activity.creatorId) continue;
      const payload = activity.payload as Record<string, unknown>;
      if (
         payload &&
         payload.amount !== undefined &&
         payload.price_at_trade !== undefined &&
         payload.price_at_trade !== null
      ) {
         try {
            const tradeVolume =
               BigInt(Math.trunc(Number(payload.amount))) *
               BigInt(payload.price_at_trade as string | number);

            volume7dMap.set(
               activity.creatorId,
               (volume7dMap.get(activity.creatorId) ?? 0n) + tradeVolume
            );

            if (activity.createdAt >= window24hStart) {
               volume24hMap.set(
                  activity.creatorId,
                  (volume24hMap.get(activity.creatorId) ?? 0n) + tradeVolume
               );
            }
         } catch {
            continue;
         }
      }
   }

   const unranked = creators.map(creator => {
      const holderCount = holderCountsByCreator.get(creator.id) ?? 0;
      const volume24h = volume24hMap.get(creator.id) ?? 0n;
      const volume7d = volume7dMap.get(creator.id) ?? 0n;
      const snapshot = creator.priceSnapshot;
      const priceChange = snapshot
         ? compute24hPriceChange(snapshot.currentPrice, snapshot.price24hAgo)
         : 0;

      let metricValue: number | string = 0;
      if (sortBy === 'holder_count') metricValue = holderCount;
      else if (sortBy === 'volume_24h') metricValue = volume24h.toString();
      else if (sortBy === 'volume_7d') metricValue = volume7d.toString();
      else if (sortBy === 'price_change') metricValue = priceChange ?? 0;

      return {
         keyId: creator.id,
         creatorName: creator.displayName,
         handle: creator.handle,
         avatarUrl: creator.avatarUrl,
         createdAt: creator.createdAt,
         holder_count: holderCount,
         volume_24h: volume24h.toString(),
         volume_7d: volume7d.toString(),
         price_change: priceChange,
         metricValue,
         numericMetric:
            sortBy === 'volume_24h'
               ? Number(volume24h)
               : sortBy === 'volume_7d'
               ? Number(volume7d)
               : Number(metricValue),
      };
   });

   unranked.sort((a, b) => {
      const diff = b.numericMetric - a.numericMetric;
      if (diff !== 0) {
         return diff > 0 ? 1 : -1;
      }
      // Tied primary metric: secondary sort by creation date ascending (earlier created first)
      const timeDiff = a.createdAt.getTime() - b.createdAt.getTime();
      if (timeDiff !== 0) {
         return timeDiff;
      }
      // Tertiary tie-breaker: keyId ascending
      return a.keyId < b.keyId ? -1 : a.keyId > b.keyId ? 1 : 0;
   });

   return unranked.slice(0, limit).map((entry, index) => ({
      rank: index + 1,
      keyId: entry.keyId,
      creatorName: entry.creatorName,
      handle: entry.handle,
      avatarUrl: entry.avatarUrl,
      holder_count: entry.holder_count,
      volume_24h: entry.volume_24h,
      volume_7d: entry.volume_7d,
      price_change: entry.price_change,
      metricValue: entry.metricValue,
   }));
}

export async function getKeyLeaderboard(
   sortBy: KeyLeaderboardSortBy,
   limit: number
): Promise<KeyLeaderboardEntry[]> {
   const redis = getRedis();
   const cacheKey = `leaderboard:keys:${sortBy}:v1`;

   if (redis) {
      try {
         const cached = await withTimeout(
            redis.get(cacheKey),
            REDIS_OP_TIMEOUT_MS
         );
         if (cached) {
            const allCached = JSON.parse(cached) as KeyLeaderboardEntry[];
            return allCached.slice(0, limit);
         }
      } catch (error) {
         logger.warn(
            { error, sortBy },
            'Key leaderboard cache read failed; computing live'
         );
      }
   }

   // Compute up to MAX_PAGE_SIZE (100) so caching covers all requested limit values up to max
   const leaderboard = await computeKeyLeaderboard(sortBy, MAX_PAGE_SIZE);

   if (redis) {
      try {
         await withTimeout(
            redis.set(
               cacheKey,
               JSON.stringify(leaderboard),
               'EX',
               CACHE_TTL_SECONDS
            ),
            REDIS_OP_TIMEOUT_MS
         );
      } catch (error) {
         logger.warn(
            { error, sortBy },
            'Key leaderboard cache write failed; serving uncached result'
         );
      }
   }

   return leaderboard.slice(0, limit);
}
