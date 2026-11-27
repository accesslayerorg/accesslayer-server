// src/modules/analytics/key-leaderboard-analytics.service.ts
//
// Platform-wide key discovery leaderboard: GET /analytics/keys/leaderboard.
//
// - Metrics: `volume` (24h trade volume), `holders` (keys with a positive
//   balance) and `reputation` (CreatorReputation.currentScore).
// - `24h_change` is the percent change in key price between the latest daily
//   snapshot and the snapshot one UTC day earlier (KeyAnalyticsSnapshot).
//   It is null when the key has no such pair.
// - The full top-100 ranking per metric is cached for 5 minutes and rebuilt by
//   the analytics refresh job, so cached requests only slice the array.

import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';
import { logger } from '../../utils/logger.utils';

export const KEY_ANALYTICS_LEADERBOARD_METRICS = [
   'volume',
   'holders',
   'reputation',
] as const;

export type KeyAnalyticsLeaderboardMetric =
   (typeof KEY_ANALYTICS_LEADERBOARD_METRICS)[number];

export const KEY_ANALYTICS_LEADERBOARD_DEFAULT_LIMIT = 20;
export const KEY_ANALYTICS_LEADERBOARD_MAX_LIMIT = 100;
export const KEY_ANALYTICS_LEADERBOARD_CACHE_SECONDS = 300;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface KeyAnalyticsLeaderboardEntry {
   rank: number;
   key_id: string;
   key_name: string;
   creator: string;
   /** Volume is a stroop string to keep precision; holders and reputation are numbers. */
   metric_value: string | number;
   '24h_change': number | null;
}

export interface RankableKey {
   keyId: string;
   keyName: string;
   creator: string;
   value: bigint;
   change: number | null;
}

export function buildKeyAnalyticsLeaderboardCacheKey(
   metric: KeyAnalyticsLeaderboardMetric
): string {
   return `analytics:keys:leaderboard:${metric}:v1`;
}

/**
 * Percent change between the latest snapshot and the snapshot exactly one UTC
 * day before it. Returns null when that earlier snapshot is missing or has a
 * zero price, so a gap in the daily series never produces a bogus change.
 */
export function computeDailySnapshotChange(
   snapshots: ReadonlyArray<{ snapshotDate: Date; price: bigint }>
): number | null {
   if (snapshots.length < 2) return null;

   const sorted = [...snapshots].sort(
      (a, b) => b.snapshotDate.getTime() - a.snapshotDate.getTime()
   );
   const latest = sorted[0];
   const previousDay = latest.snapshotDate.getTime() - DAY_MS;
   const previous = sorted.find(
      snapshot => snapshot.snapshotDate.getTime() === previousDay
   );
   if (!previous || previous.price <= 0n) return null;

   // Integer basis points keep the division exact before the final float step.
   const basisPoints = ((latest.price - previous.price) * 10000n) / previous.price;
   return Number(basisPoints) / 100;
}

/**
 * Orders keys by metric value descending, breaking ties by key id ascending,
 * and returns the top `limit` entries with 1-based ranks.
 */
export function rankKeyAnalyticsLeaderboard(
   metric: KeyAnalyticsLeaderboardMetric,
   rows: ReadonlyArray<RankableKey>,
   limit: number
): KeyAnalyticsLeaderboardEntry[] {
   const sorted = [...rows].sort((a, b) => {
      if (a.value !== b.value) return a.value > b.value ? -1 : 1;
      if (a.keyId === b.keyId) return 0;
      return a.keyId < b.keyId ? -1 : 1;
   });

   return sorted.slice(0, limit).map((row, index) => ({
      rank: index + 1,
      key_id: row.keyId,
      key_name: row.keyName,
      creator: row.creator,
      metric_value:
         metric === 'volume' ? row.value.toString() : Number(row.value),
      '24h_change': row.change,
   }));
}

async function loadMetricValues(
   metric: KeyAnalyticsLeaderboardMetric,
   keyIds: string[],
   since24h: Date
): Promise<Map<string, bigint>> {
   const values = new Map<string, bigint>();

   if (metric === 'holders') {
      const groups = await prisma.keyOwnership.groupBy({
         by: ['creatorId'],
         where: { creatorId: { in: keyIds }, balance: { gt: 0 } },
         _count: { ownerAddress: true },
      });
      for (const group of groups) {
         values.set(group.creatorId, BigInt(group._count.ownerAddress));
      }
      return values;
   }

   if (metric === 'reputation') {
      const reputations = await prisma.creatorReputation.findMany({
         where: { creatorId: { in: keyIds } },
         select: { creatorId: true, currentScore: true },
      });
      for (const reputation of reputations) {
         values.set(reputation.creatorId, BigInt(reputation.currentScore));
      }
      return values;
   }

   // 24h volume: trade amount x price at trade, the same valuation used by
   // the key discovery leaderboard. Malformed payloads are skipped.
   const trades = await prisma.activity.findMany({
      where: {
         type: { in: ['KEY_BOUGHT', 'KEY_SOLD'] },
         creatorId: { in: keyIds },
         createdAt: { gte: since24h },
      },
      select: { creatorId: true, payload: true },
   });
   for (const trade of trades) {
      if (!trade.creatorId) continue;
      const payload = trade.payload as Record<string, unknown> | null;
      if (
         !payload ||
         payload.amount === undefined ||
         payload.price_at_trade === undefined ||
         payload.price_at_trade === null
      ) {
         continue;
      }
      try {
         const tradeVolume =
            BigInt(Math.trunc(Number(payload.amount))) *
            BigInt(payload.price_at_trade as string | number);
         values.set(
            trade.creatorId,
            (values.get(trade.creatorId) ?? 0n) + tradeVolume
         );
      } catch {
         continue;
      }
   }
   return values;
}

/** Computes the full ranking (up to the max limit) for one metric. */
export async function computeKeyAnalyticsLeaderboard(
   metric: KeyAnalyticsLeaderboardMetric
): Promise<KeyAnalyticsLeaderboardEntry[]> {
   const now = new Date();
   const since24h = new Date(now.getTime() - DAY_MS);
   const utcDayStart = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate()
   );

   const creators = await prisma.creatorProfile.findMany({
      select: { id: true, handle: true, displayName: true },
   });
   if (creators.length === 0) return [];

   const keyIds = creators.map(creator => creator.id);
   const [values, snapshots] = await Promise.all([
      loadMetricValues(metric, keyIds, since24h),
      prisma.keyAnalyticsSnapshot.findMany({
         where: {
            creatorId: { in: keyIds },
            snapshotDate: { gte: new Date(utcDayStart - DAY_MS) },
         },
         select: { creatorId: true, snapshotDate: true, price: true },
      }),
   ]);

   const snapshotsByKey = new Map<
      string,
      Array<{ snapshotDate: Date; price: bigint }>
   >();
   for (const snapshot of snapshots) {
      const list = snapshotsByKey.get(snapshot.creatorId) ?? [];
      list.push({ snapshotDate: snapshot.snapshotDate, price: snapshot.price });
      snapshotsByKey.set(snapshot.creatorId, list);
   }

   const rows: RankableKey[] = creators.map(creator => ({
      keyId: creator.id,
      keyName: creator.displayName,
      creator: creator.handle,
      value: values.get(creator.id) ?? 0n,
      change: computeDailySnapshotChange(snapshotsByKey.get(creator.id) ?? []),
   }));

   return rankKeyAnalyticsLeaderboard(
      metric,
      rows,
      KEY_ANALYTICS_LEADERBOARD_MAX_LIMIT
   );
}

/** Recomputes one metric's ranking and stores it in the cache. */
export async function refreshKeyAnalyticsLeaderboard(
   metric: KeyAnalyticsLeaderboardMetric
): Promise<KeyAnalyticsLeaderboardEntry[]> {
   const ranking = await computeKeyAnalyticsLeaderboard(metric);
   await cacheSetJson(
      buildKeyAnalyticsLeaderboardCacheKey(metric),
      ranking,
      KEY_ANALYTICS_LEADERBOARD_CACHE_SECONDS
   );
   return ranking;
}

/** Refresh hook for the analytics cron. One metric failing does not stop the others. */
export async function refreshAllKeyAnalyticsLeaderboards(): Promise<void> {
   for (const metric of KEY_ANALYTICS_LEADERBOARD_METRICS) {
      try {
         await refreshKeyAnalyticsLeaderboard(metric);
      } catch (error) {
         logger.error(
            { err: error, metric },
            'Key analytics leaderboard refresh failed'
         );
      }
   }
}

/** Serves from cache when warm, otherwise computes and caches the ranking. */
export async function getKeyAnalyticsLeaderboard(
   metric: KeyAnalyticsLeaderboardMetric,
   limit: number
): Promise<KeyAnalyticsLeaderboardEntry[]> {
   const cached = await cacheGetJson<KeyAnalyticsLeaderboardEntry[]>(
      buildKeyAnalyticsLeaderboardCacheKey(metric)
   );
   const ranking =
      cached ?? (await refreshKeyAnalyticsLeaderboard(metric));
   return ranking.slice(0, limit);
}
