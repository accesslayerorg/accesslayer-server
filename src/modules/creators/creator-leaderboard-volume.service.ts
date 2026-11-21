// src/modules/creators/creator-leaderboard-volume.service.ts
// GET /api/v1/creators/leaderboard/volume (#785)
//
// Ranks creator keys by total trading volume (buys + sells combined) over a
// rolling window, backed by a short-lived Redis cache so the aggregation
// query doesn't run on every request.

import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { getRedis } from '../../utils/redis.utils';
import { envConfig } from '../../config';
import { compute24hPriceChange } from '../../utils/price.utils';

export interface VolumeLeaderboardEntry {
   rank: number;
   keyId: string;
   creatorName: string;
   avatarUrl: string | null;
   /** Total trade volume in stroops over the window, as a decimal string. */
   totalVolume: string;
   priceChange24h: number | null;
}

const LEADERBOARD_LIMIT = 20;
const CACHE_KEY = 'leaderboard:volume:v1';

// The shared Redis client is configured with maxRetriesPerRequest: null
// (see src/utils/redis.utils.ts), so a command issued while Redis is
// unreachable would otherwise retry forever. Bound every cache operation
// here so a Redis outage degrades to "compute live" / "skip invalidation"
// instead of hanging the request (or, for invalidation, the indexer
// pipeline).
const REDIS_OP_TIMEOUT_MS = 1000;

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

function windowMs(): number {
   return envConfig.LEADERBOARD_VOLUME_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * Recomputes the volume leaderboard directly from the Activity read model,
 * bypassing the cache. Volume for a trade is `amount * price_at_trade`
 * (both stored in the KEY_BOUGHT / KEY_SOLD activity payload), summed across
 * both event types so buys and sells both count toward a key's volume.
 */
export async function computeVolumeLeaderboard(): Promise<
   VolumeLeaderboardEntry[]
> {
   const now = Date.now();
   const windowStart = new Date(now - windowMs());

   const activities = await prisma.activity.findMany({
      where: {
         type: { in: ['KEY_BOUGHT', 'KEY_SOLD'] },
         creatorId: { not: null },
         createdAt: { gte: windowStart, lte: new Date(now) },
      },
      select: { creatorId: true, payload: true },
   });

   const volumeByCreator = new Map<string, bigint>();
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
            volumeByCreator.set(
               activity.creatorId,
               (volumeByCreator.get(activity.creatorId) ?? 0n) + tradeVolume
            );
         } catch {
            // Skip malformed payloads rather than fail the whole leaderboard.
            continue;
         }
      }
   }

   if (volumeByCreator.size === 0) {
      return [];
   }

   const creators = await prisma.creatorProfile.findMany({
      where: { id: { in: [...volumeByCreator.keys()] } },
      select: {
         id: true,
         displayName: true,
         avatarUrl: true,
         priceSnapshot: {
            select: { currentPrice: true, price24hAgo: true },
         },
      },
   });

   const unranked = creators.map(creator => {
      const totalVolume = volumeByCreator.get(creator.id) ?? 0n;
      const snapshot = creator.priceSnapshot;
      const priceChange24h = snapshot
         ? compute24hPriceChange(snapshot.currentPrice, snapshot.price24hAgo)
         : null;

      return {
         keyId: creator.id,
         creatorName: creator.displayName,
         avatarUrl: creator.avatarUrl,
         totalVolume,
         priceChange24h,
      };
   });

   unranked.sort((a, b) => {
      if (a.totalVolume === b.totalVolume) {
         return a.keyId < b.keyId ? -1 : a.keyId > b.keyId ? 1 : 0;
      }
      return a.totalVolume > b.totalVolume ? -1 : 1;
   });

   return unranked.slice(0, LEADERBOARD_LIMIT).map((entry, index) => ({
      rank: index + 1,
      keyId: entry.keyId,
      creatorName: entry.creatorName,
      avatarUrl: entry.avatarUrl,
      totalVolume: entry.totalVolume.toString(),
      priceChange24h: entry.priceChange24h,
   }));
}

/**
 * Returns the volume leaderboard, serving from the Redis cache when a fresh
 * entry exists. Falls back to a live computation (without caching the
 * result) if Redis is unreachable, so a cache outage never breaks the
 * endpoint.
 */
export async function getVolumeLeaderboard(): Promise<
   VolumeLeaderboardEntry[]
> {
   const redis = getRedis();

   if (redis) {
      try {
         const cached = await withTimeout(
            redis.get(CACHE_KEY),
            REDIS_OP_TIMEOUT_MS
         );
         if (cached) {
            return JSON.parse(cached) as VolumeLeaderboardEntry[];
         }
      } catch (error) {
         logger.warn(
            { error },
            'Volume leaderboard cache read failed; computing live'
         );
      }
   }

   const leaderboard = await computeVolumeLeaderboard();

   if (redis) {
      try {
         await withTimeout(
            redis.set(
               CACHE_KEY,
               JSON.stringify(leaderboard),
               'EX',
               envConfig.LEADERBOARD_VOLUME_CACHE_TTL_SECONDS
            ),
            REDIS_OP_TIMEOUT_MS
         );
      } catch (error) {
         logger.warn(
            { error },
            'Volume leaderboard cache write failed; serving uncached result'
         );
      }
   }

   return leaderboard;
}

/**
 * Invalidates the cached volume leaderboard. Called after a new trade is
 * recorded so the leaderboard reflects it within the next request instead of
 * waiting out the full TTL.
 */
export async function invalidateVolumeLeaderboardCache(): Promise<void> {
   try {
      const redis = getRedis();
      if (redis) {
         await withTimeout(redis.del(CACHE_KEY), REDIS_OP_TIMEOUT_MS);
      }
   } catch (error) {
      logger.warn({ error }, 'Failed to invalidate volume leaderboard cache');
   }
}
