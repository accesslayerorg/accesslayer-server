// src/modules/analytics/key-leaderboard.service.ts
import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson, cacheInvalidate, getRedis } from '../../utils/redis.utils';
import { logger } from '../../utils/logger.utils';

export type LeaderboardMetric = 'volume' | 'holders' | 'reputation';

export interface DiscoveryLeaderboardEntry {
   rank: number;
   key_id: string;
   key_name: string;
   creator: string;
   metric_value: string;
   '24h_change': string;
}

export const LEADERBOARD_CACHE_TTL_SECONDS = 300; // 5 minutes

export function getLeaderboardCacheKey(metric: LeaderboardMetric, limit: number): string {
   return `analytics:keys:leaderboard:${metric}:${limit}`;
}

export async function invalidateDiscoveryLeaderboardCache(): Promise<void> {
   try {
      const redis = getRedis();
      if (redis && typeof redis.keys === 'function') {
         const keys = await redis.keys('analytics:keys:leaderboard:*');
         for (const k of keys) {
            await cacheInvalidate(k);
         }
      } else {
         await cacheInvalidate('analytics:keys:leaderboard:volume:100');
         await cacheInvalidate('analytics:keys:leaderboard:holders:100');
         await cacheInvalidate('analytics:keys:leaderboard:reputation:100');
      }
   } catch (error) {
      logger.warn({ error }, 'Failed to invalidate discovery leaderboard cache');
   }
}

export async function getKeyDiscoveryLeaderboard(
   metric: LeaderboardMetric = 'volume',
   requestedLimit = 50
): Promise<DiscoveryLeaderboardEntry[]> {
   const limit = Math.min(Math.max(1, requestedLimit), 100);
   const cacheKey = getLeaderboardCacheKey(metric, limit);

   const cached = await cacheGetJson<DiscoveryLeaderboardEntry[]>(cacheKey);
   if (cached !== null) {
      return cached;
   }

   const creators = await prisma.creatorProfile.findMany({
      select: {
         id: true,
         displayName: true,
         handle: true,
      },
   });

   if (creators.length === 0) {
      return [];
   }

   const creatorIds = creators.map(c => c.id);
   const now = new Date();
   const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
   const twoDaysAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);

   let items: {
      creatorId: string;
      displayName: string;
      handle: string;
      metricValue: number;
      change24h: number;
   }[] = [];

   if (metric === 'volume') {
      // Recent trades in last 24h
      const recentTrades = await prisma.trade.findMany({
         where: {
            creatorId: { in: creatorIds },
            timestamp: { gte: dayAgo },
         },
         select: { creatorId: true, quantity: true, price: true },
      });

      // Older trades (24h - 48h) for 24h change
      const olderTrades = await prisma.trade.findMany({
         where: {
            creatorId: { in: creatorIds },
            timestamp: { gte: twoDaysAgo, lt: dayAgo },
         },
         select: { creatorId: true, quantity: true, price: true },
      });

      const recentVolMap = new Map<string, number>();
      for (const t of recentTrades) {
         const stroops = Number(t.price || 0) * Number(t.quantity || 1);
         recentVolMap.set(t.creatorId, (recentVolMap.get(t.creatorId) || 0) + stroops);
      }

      const olderVolMap = new Map<string, number>();
      for (const t of olderTrades) {
         const stroops = Number(t.price || 0) * Number(t.quantity || 1);
         olderVolMap.set(t.creatorId, (olderVolMap.get(t.creatorId) || 0) + stroops);
      }

      items = creators.map(c => {
         const vol24h = recentVolMap.get(c.id) || 0;
         const prevVol = olderVolMap.get(c.id) || 0;
         const change = prevVol > 0 ? ((vol24h - prevVol) / prevVol) * 100 : (vol24h > 0 ? 100 : 0);

         return {
            creatorId: c.id,
            displayName: c.displayName,
            handle: c.handle,
            metricValue: vol24h,
            change24h: Math.round(change * 100) / 100,
         };
      });
   } else if (metric === 'holders') {
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

      const holderCountMap = new Map<string, number>();
      for (const g of holderGroups) {
         holderCountMap.set(g.creatorId, g._count.ownerAddress);
      }

      items = creators.map(c => {
         const count = holderCountMap.get(c.id) || 0;
         return {
            creatorId: c.id,
            displayName: c.displayName,
            handle: c.handle,
            metricValue: count,
            change24h: 0,
         };
      });
   } else if (metric === 'reputation') {
      const reputations = await prisma.creatorReputation.findMany({
         where: {
            creatorId: { in: creatorIds },
         },
         select: {
            creatorId: true,
            currentScore: true,
         },
      });

      const repMap = new Map<string, number>();
      for (const r of reputations) {
         repMap.set(r.creatorId, r.currentScore);
      }

      items = creators.map(c => {
         const score = repMap.get(c.id) || 0;
         return {
            creatorId: c.id,
            displayName: c.displayName,
            handle: c.handle,
            metricValue: score,
            change24h: 0,
         };
      });
   }

   // Sort descending by metricValue
   items.sort((a, b) => b.metricValue - a.metricValue);

   const result: DiscoveryLeaderboardEntry[] = items.slice(0, limit).map((item, idx) => ({
      rank: idx + 1,
      key_id: item.creatorId,
      key_name: item.displayName || item.handle,
      creator: item.handle,
      metric_value: item.metricValue.toString(),
      '24h_change': `${item.change24h > 0 ? '+' : ''}${item.change24h}%`,
   }));

   try {
      await cacheSetJson(cacheKey, result, LEADERBOARD_CACHE_TTL_SECONDS);
   } catch (error) {
      logger.warn({ error }, 'Failed to cache discovery leaderboard');
   }

   return result;
}
