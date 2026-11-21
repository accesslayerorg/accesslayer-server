import { prisma } from '../../utils/prisma.utils';
import {
   cacheGetJson,
   cacheInvalidate,
   cacheSetJson,
} from '../../utils/redis.utils';

export const KEY_LEADERBOARD_CACHE_TTL_SECONDS = 60;
export const KEY_LEADERBOARD_METRICS = [
   'volume',
   'pnl',
   'holding_days',
] as const;

export type KeyLeaderboardMetric = (typeof KEY_LEADERBOARD_METRICS)[number];
type MetricField = 'volume' | 'pnl' | 'holdingDays';

const METRIC_FIELDS: Record<KeyLeaderboardMetric, MetricField> = {
   volume: 'volume',
   pnl: 'pnl',
   holding_days: 'holdingDays',
};

export interface KeyLeaderboardEntry {
   rank: number;
   wallet: string;
   score: string;
}

export interface WalletLeaderboardMetric {
   rank: number;
   score: string;
}

export interface WalletKeyLeaderboard {
   keyId: string;
   wallet: string;
   metrics: Record<KeyLeaderboardMetric, WalletLeaderboardMetric | null>;
}

export const keyLeaderboardCacheKey = (creatorId: string): string =>
   `key:leaderboard:${creatorId}:`;

function listCacheKey(
   creatorId: string,
   metric: KeyLeaderboardMetric,
   limit: number
): string {
   return `${keyLeaderboardCacheKey(creatorId)}${metric}:${limit}`;
}

export async function invalidateKeyLeaderboardCache(
   creatorId: string
): Promise<void> {
   await cacheInvalidate(`${keyLeaderboardCacheKey(creatorId)}*`);
}

export async function getKeyEventLeaderboard(
   creatorId: string,
   metric: KeyLeaderboardMetric,
   limit: number
): Promise<KeyLeaderboardEntry[]> {
   const cacheKey = listCacheKey(creatorId, metric, limit);
   const cached = await cacheGetJson<KeyLeaderboardEntry[]>(cacheKey);
   if (cached) return cached;

   const field = METRIC_FIELDS[metric];
   const rows = await prisma.keyLeaderboard.findMany({
      where: { creatorId },
      orderBy: [{ [field]: 'desc' }, { wallet: 'asc' }],
      take: limit,
      select: {
         wallet: true,
         volume: true,
         pnl: true,
         holdingDays: true,
      },
   });
   const items = rows.map((row, index) => ({
      rank: index + 1,
      wallet: row.wallet,
      score: String(row[field]),
   }));

   await cacheSetJson(cacheKey, items, KEY_LEADERBOARD_CACHE_TTL_SECONDS);
   return items;
}

export async function getWalletKeyLeaderboard(
   creatorId: string,
   wallet: string
): Promise<WalletKeyLeaderboard> {
   const cacheKey = `${keyLeaderboardCacheKey(creatorId)}wallet:${wallet}`;
   const cached = await cacheGetJson<WalletKeyLeaderboard>(cacheKey);
   if (cached) return cached;

   const row = await prisma.keyLeaderboard.findUnique({
      where: { creatorId_wallet: { creatorId, wallet } },
      select: {
         wallet: true,
         volume: true,
         pnl: true,
         holdingDays: true,
      },
   });

   const metrics = {} as WalletKeyLeaderboard['metrics'];
   for (const metric of KEY_LEADERBOARD_METRICS) {
      const field = METRIC_FIELDS[metric];
      if (!row) {
         metrics[metric] = null;
         continue;
      }

      const score = row[field];
      const aheadCount = await prisma.keyLeaderboard.count({
         where: {
            creatorId,
            OR: [
               { [field]: { gt: score } },
               { [field]: score, wallet: { lt: wallet } },
            ],
         },
      });
      metrics[metric] = {
         rank: aheadCount + 1,
         score: String(score),
      };
   }

   const result = { keyId: creatorId, wallet, metrics };
   await cacheSetJson(cacheKey, result, KEY_LEADERBOARD_CACHE_TTL_SECONDS);
   return result;
}
