// src/modules/creator/creator-analytics.service.ts
// Daily aggregated trade analytics for a creator key over the trailing 30
// days. All buckets are computed in UTC so the series is stable across
// server timezones.
//
// Definitions (per the product spec):
// - activeHolders: unique wallets that traded (bought OR sold) the key that day.
// - newHolders:    wallets whose FIRST EVER buy of this key happened that day.
// - tradeVolume:   sum of XLM amounts across buys and sells that day.

import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   ANALYTICS_WINDOW_DAYS,
} from './creator-analytics.constants';

export interface CreatorAnalyticsDayPoint {
   /** UTC calendar day, `YYYY-MM-DD`. */
   date: string;
   activeHolders: number;
   tradeVolume: number;
   newHolders: number;
}

export interface CreatorAnalyticsResult {
   keyId: string;
   windowDays: number;
   generatedAt: string;
   series: CreatorAnalyticsDayPoint[];
}

type TradeRow = {
   actor: string;
   type: 'KEY_BOUGHT' | 'KEY_SOLD';
   payload: unknown;
   createdAt: Date;
};

/**
 * Extract an XLM amount from an activity payload. Indexer payloads have not
 * settled on a single field name yet, so tolerate the common shapes:
 * `{ amount }`, `{ price }`, `{ value }` as string | number.
 */
export function extractXlmAmount(payload: unknown): number {
   if (payload === null || typeof payload !== 'object') return 0;
   const record = payload as Record<string, unknown>;
   for (const field of ['amount', 'price', 'value']) {
      const raw = record[field];
      if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
      if (typeof raw === 'string' && raw.trim() !== '') {
         const parsed = Number(raw);
         if (Number.isFinite(parsed)) return parsed;
      }
   }
   return 0;
}

/** `YYYY-MM-DD` for a date in UTC. */
export function toUtcDateString(date: Date): string {
   return date.toISOString().slice(0, 10);
}

/**
 * Build the list of 30 UTC day strings from (today - 29) through today.
 * Ordered oldest → newest so the series is chart-ready.
 */
export function buildUtcDayWindow(now: Date): string[] {
   const today = toUtcDateString(now);
   const days: string[] = [];
   const cursor = new Date(`${today}T00:00:00.000Z`);

   for (let offset = ANALYTICS_WINDOW_DAYS - 1; offset >= 0; offset -= 1) {
      const day = new Date(cursor);
      day.setUTCDate(day.getUTCDate() - offset);
      days.push(toUtcDateString(day));
   }
   return days;
}

function indexTradesByDay(trades: TradeRow[]): Map<string, TradeRow[]> {
   const byDay = new Map<string, TradeRow[]>();
   for (const trade of trades) {
      const day = toUtcDateString(trade.createdAt);
      const bucket = byDay.get(day);
      if (bucket) {
         bucket.push(trade);
      } else {
         byDay.set(day, [trade]);
      }
   }
   return byDay;
}

/**
 * Compute first-ever-buy UTC day per wallet for a key, then keep only the
 * wallets whose first buy falls inside the analytics window.
 */
async function loadFirstBuyDays(
   keyId: string,
   windowStart: Date
): Promise<Map<string, string>> {
   const firstBuys = await prisma.activity.groupBy({
      by: ['actor'],
      where: {
         creatorId: keyId,
         type: 'KEY_BOUGHT',
      },
      _min: { createdAt: true },
   });

   const result = new Map<string, string>();
   for (const row of firstBuys) {
      const minCreatedAt = row._min.createdAt;
      if (!minCreatedAt || minCreatedAt < windowStart) continue;
      result.set(row.actor, toUtcDateString(minCreatedAt));
   }
   return result;
}

/**
 * Aggregate daily analytics for a key. Returns exactly
 * {@link ANALYTICS_WINDOW_DAYS} data points ordered oldest → newest; days
 * without trades are zero-filled.
 */
export async function getCreatorAnalytics(
   keyId: string,
   now: Date = new Date()
): Promise<CreatorAnalyticsResult> {
   const windowStart = new Date(now);
   windowStart.setUTCDate(windowStart.getUTCDate() - (ANALYTICS_WINDOW_DAYS - 1));
   windowStart.setUTCHours(0, 0, 0, 0);

   const [trades, firstBuyDays] = await Promise.all([
      prisma.activity.findMany({
         where: {
            creatorId: keyId,
            type: { in: ['KEY_BOUGHT', 'KEY_SOLD'] },
            createdAt: { gte: windowStart },
         },
         select: {
            actor: true,
            type: true,
            payload: true,
            createdAt: true,
         },
      }) as Promise<TradeRow[]>,
      loadFirstBuyDays(keyId, windowStart),
   ]);

   const tradesByDay = indexTradesByDay(trades);
   const newHoldersByDay = new Map<string, number>();
   for (const firstBuyDay of firstBuyDays.values()) {
      newHoldersByDay.set(firstBuyDay, (newHoldersByDay.get(firstBuyDay) ?? 0) + 1);
   }

   const series = buildUtcDayWindow(now).map((date) => {
      const dayTrades = tradesByDay.get(date) ?? [];
      const activeWallets = new Set<string>();
      let volume = 0;

      for (const trade of dayTrades) {
         activeWallets.add(trade.actor);
         volume += extractXlmAmount(trade.payload);
      }

      return {
         date,
         activeHolders: activeWallets.size,
         tradeVolume: Number(volume.toFixed(7)),
         newHolders: newHoldersByDay.get(date) ?? 0,
      };
   });

   logger.debug(
      {
         type: 'creator_analytics_computed',
         keyId,
         tradesConsidered: trades.length,
         windowDays: ANALYTICS_WINDOW_DAYS,
      },
      'Creator analytics computed'
   );

   return {
      keyId,
      windowDays: ANALYTICS_WINDOW_DAYS,
      generatedAt: now.toISOString(),
      series,
   };
}
