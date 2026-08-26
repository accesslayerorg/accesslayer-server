// src/modules/analytics/analytics.service.ts
// Computes the daily key-performance time series used by the creator dashboard.

import { prisma } from '../../utils/prisma.utils';

export interface DailyAnalyticsPoint {
   date: string; // YYYY-MM-DD
   activeHolders: number;
   tradeVolume: number; // total XLM traded (buy + sell) that day
   newHolders: number; // wallets whose first-ever BUY was that day
}

export interface KeyAnalytics {
   keyId: string;
   points: DailyAnalyticsPoint[];
}

const DAYS = 30;

function toNumber(value: unknown): number {
   if (value == null) return 0;
   if (typeof value === 'number') return value;
   try {
      return Number(value.toString());
   } catch {
      return 0;
   }
}

function startOfDay(date: Date): Date {
   const d = new Date(date);
   d.setHours(0, 0, 0, 0);
   return d;
}

function formatDate(date: Date): string {
   const y = date.getUTCFullYear();
   const m = String(date.getUTCMonth() + 1).padStart(2, '0');
   const d = String(date.getUTCDate()).padStart(2, '0');
   return `${y}-${m}-${d}`;
}

/**
 * Resolves the on-chain wallet address that owns (created) the key.
 * Returns null when the key/profile does not exist.
 */
export async function getCreatorKeyWallet(
   keyId: string
): Promise<string | null> {
   const profile = await prisma.creatorProfile.findUnique({
      where: { id: keyId },
      include: {
         user: {
            include: {
               stellarWallet: true,
            },
         },
      },
   });

   if (!profile || !profile.user?.stellarWallet) {
      return null;
   }
   return profile.user.stellarWallet.address;
}

/**
 * Returns the creator's key performance as a daily time series for the past
 * 30 days (one point per day, oldest first). Days without activity still appear
 * with zeroed metrics so the dashboard always renders a complete chart.
 */
export async function getKeyAnalytics(keyId: string): Promise<KeyAnalytics> {
   const now = new Date();
   const today = startOfDay(now);
   const windowStart = new Date(today);
   windowStart.setUTCDate(windowStart.getUTCDate() - (DAYS - 1));

   // Pre-build the 30 day buckets so every day is present in the output.
   const buckets: DailyAnalyticsPoint[] = [];
   const indexByDate = new Map<string, DailyAnalyticsPoint>();
   for (let i = 0; i < DAYS; i++) {
      const day = new Date(windowStart);
      day.setUTCDate(day.getUTCDate() + i);
      const point: DailyAnalyticsPoint = {
         date: formatDate(day),
         activeHolders: 0,
         tradeVolume: 0,
         newHolders: 0,
      };
      buckets.push(point);
      indexByDate.set(point.date, point);
   }

   const trades = await prisma.trade.findMany({
      where: {
         keyId,
         createdAt: { gte: windowStart, lte: now },
      },
      select: {
         wallet: true,
         side: true,
         amount: true,
         createdAt: true,
      },
   });

   for (const trade of trades) {
      const dayKey = formatDate(startOfDay(trade.createdAt));
      const bucket = indexByDate.get(dayKey);
      if (!bucket) continue;
      bucket.tradeVolume += toNumber(trade.amount);
   }

   // De-duplicate active holders per day (a wallet may trade multiple times).
   // We recompute counts from a per-day wallet set.
   const perDayWallets = new Map<string, Set<string>>();
   for (const trade of trades) {
      const dayKey = formatDate(startOfDay(trade.createdAt));
      if (!perDayWallets.has(dayKey)) perDayWallets.set(dayKey, new Set());
      perDayWallets.get(dayKey)!.add(trade.wallet);
   }
   for (const [dayKey, wallets] of perDayWallets) {
      const bucket = indexByDate.get(dayKey);
      if (bucket) bucket.activeHolders = wallets.size;
   }

   // New holders: wallets whose first-ever BUY for this key falls in the window.
   const firstBuys = await prisma.trade.groupBy({
      by: ['wallet'],
      where: { keyId, side: 'BUY' },
      _min: { createdAt: true },
   });
   for (const row of firstBuys) {
      const firstBuyDate = row._min.createdAt;
      if (!firstBuyDate) continue;
      const dayKey = formatDate(startOfDay(firstBuyDate));
      const bucket = indexByDate.get(dayKey);
      if (bucket) bucket.newHolders += 1;
   }

   return { keyId, points: buckets };
}
