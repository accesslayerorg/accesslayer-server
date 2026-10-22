// src/modules/portfolio/portfolio-history.service.ts
// GET /portfolio/history (#1008): total value of a wallet's creator key
// holdings over time — the data behind the portfolio performance chart.
//
// Value at an instant = (holdings balance as of that instant) x (price as of
// that instant):
//
// - balances come from WalletHoldingSnapshot rows, appended on every trade
//   event (see holding-snapshot.service.ts);
// - prices come from CreatorPriceHistory rows (stroops per key, converted
//   to XLM), the same rows behind GET /keys/:id/price-history.
//
// Both series are replayed as-of: the latest recorded row at or before the
// instant. Points are anchored at `now` and step backwards by the range's
// granularity (hourly for 7d, daily for 30d/90d, weekly for all time), so
// the last point is always "right now".
//
// Results are cached in Redis for 5 minutes per wallet per range.

import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';
import { logger } from '../../utils/logger.utils';

export const PORTFOLIO_HISTORY_RANGES = [
   '7d',
   '30d',
   '90d',
   'all',
] as const;
export type PortfolioHistoryRange = (typeof PORTFOLIO_HISTORY_RANGES)[number];

export type PortfolioHistoryInterval = 'hourly' | 'daily' | 'weekly';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/**
 * Lookback window per range. `null` for 'all', whose window starts at the
 * wallet's first recorded activity (earliest snapshot or position row).
 */
export const RANGE_WINDOW_MS: Record<PortfolioHistoryRange, number | null> = {
   '7d': 7 * DAY_MS,
   '30d': 30 * DAY_MS,
   '90d': 90 * DAY_MS,
   all: null,
};

/** Granularity per range: hourly for 7d, daily for 30d/90d, weekly for all. */
export const RANGE_INTERVAL_MS: Record<PortfolioHistoryRange, number> = {
   '7d': HOUR_MS,
   '30d': DAY_MS,
   '90d': DAY_MS,
   all: WEEK_MS,
};

export const RANGE_INTERVAL: Record<
   PortfolioHistoryRange,
   PortfolioHistoryInterval
> = {
   '7d': 'hourly',
   '30d': 'daily',
   '90d': 'daily',
   all: 'weekly',
};

/** Response cache: 5 minutes, one entry per wallet per range (#1008). */
export const PORTFOLIO_HISTORY_CACHE_TTL_SECONDS = 5 * 60;
const PORTFOLIO_HISTORY_CACHE_PREFIX = 'portfolio:history:v1:';

export function portfolioHistoryCacheKey(
   wallet: string,
   range: PortfolioHistoryRange
): string {
   return `${PORTFOLIO_HISTORY_CACHE_PREFIX}${wallet}:${range}`;
}

const STROOPS_PER_XLM = 10_000_000;

// Caps keep the range scans bounded for very busy wallets, mirroring the
// price-history cap on #893. Hitting a cap logs a warning: the most recent
// rows are kept, so the newest points stay exact and older points fall back
// to their recorded baseline.
const MAX_SNAPSHOT_ROWS = 20_000;
const MAX_PRICE_ROWS = 20_000;
// Hard cap on points returned, so a very old wallet cannot produce an
// unbounded payload (weekly points => ~7 years of history).
const MAX_POINTS = 1_000;

export interface PortfolioHistoryPoint {
   /** ISO-8601 instant this point is valued at. */
   timestamp: string;
   /** Total value of the wallet's holdings in XLM at that instant. */
   value: number;
}

export interface PortfolioHistoryResult {
   wallet: string;
   range: PortfolioHistoryRange;
   /** Granularity of the returned series for this range. */
   interval: PortfolioHistoryInterval;
   /** Distance between consecutive points, in milliseconds. */
   intervalMs: number;
   /** Unit every `value` is denominated in. */
   currency: 'XLM';
   /** Chronological series; empty when the wallet has no history. */
   points: PortfolioHistoryPoint[];
   firstValue: number;
   lastValue: number;
   /**
    * ((lastValue - firstValue) / firstValue) * 100, rounded to 4 decimals.
    * `null` when there is no first value to divide by (empty series or a
    * wallet that started at 0).
    */
   percentageReturn: number | null;
}

interface TimedValue {
   at: number;
   value: number;
}

interface HoldingTimeline {
   /** Recorded balances for one key, ascending by time. */
   snapshots: TimedValue[];
   /** Live KeyOwnership balance; undefined when the position row is gone. */
   currentBalance?: number;
   /** When the position row was created; undefined when unknown. */
   createdAt?: number;
}

function round7(value: number): number {
   return Number(value.toFixed(7));
}

function round4(value: number): number {
   return Number(value.toFixed(4));
}

function emptyHistory(
   wallet: string,
   range: PortfolioHistoryRange
): PortfolioHistoryResult {
   return {
      wallet,
      range,
      interval: RANGE_INTERVAL[range],
      intervalMs: RANGE_INTERVAL_MS[range],
      currency: 'XLM',
      points: [],
      firstValue: 0,
      lastValue: 0,
      percentageReturn: null,
   };
}

/** Index of the last entry with `at <= t`, or -1. */
function lastIndexAtOrBefore(entries: TimedValue[], t: number): number {
   let lo = 0;
   let hi = entries.length - 1;
   let found = -1;
   while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (entries[mid].at <= t) {
         found = mid;
         lo = mid + 1;
      } else {
         hi = mid - 1;
      }
   }
   return found;
}

/** Index of the first entry with `at >= t`, or -1. */
function firstIndexAtOrAfter(entries: TimedValue[], t: number): number {
   let lo = 0;
   let hi = entries.length - 1;
   let found = -1;
   while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (entries[mid].at >= t) {
         found = mid;
         hi = mid - 1;
      } else {
         lo = mid + 1;
      }
   }
   return found;
}

/**
 * Balance of one key at instant `t`:
 *
 * 1. the latest recorded snapshot at or before `t` (exact);
 * 2. else 0 when the position row was created after `t` — the wallet did
 *    not hold the key yet;
 * 3. else the first recorded snapshot carried backwards — the gap between
 *    the position row being created and snapshot recording starting;
 * 4. else the live balance — the whole position predates snapshot recording
 *    (no snapshots exist for this key at all).
 */
function balanceAsOf(timeline: HoldingTimeline, t: number): number {
   const idx = lastIndexAtOrBefore(timeline.snapshots, t);
   if (idx >= 0) {
      return timeline.snapshots[idx].value;
   }
   if (timeline.createdAt !== undefined && t < timeline.createdAt) {
      return 0;
   }
   if (timeline.snapshots.length > 0) {
      return timeline.snapshots[0].value;
   }
   return timeline.currentBalance ?? 0;
}

/**
 * Price (XLM per key) at instant `t`: the latest recorded price at or before
 * `t`; otherwise forward-fills from the first recorded price after `t` (the
 * key was not trading yet); otherwise the live snapshot price, otherwise 0.
 */
function priceAsOf(
   rows: TimedValue[],
   t: number,
   currentPrice?: number
): number {
   const idx = lastIndexAtOrBefore(rows, t);
   if (idx >= 0) {
      return rows[idx].value;
   }
   const next = firstIndexAtOrAfter(rows, t);
   if (next >= 0) {
      return rows[next].value;
   }
   return currentPrice ?? 0;
}

function toXlm(stroops: unknown): number {
   const parsed = Number(stroops);
   return Number.isFinite(parsed) ? parsed / STROOPS_PER_XLM : 0;
}

function toNumber(value: unknown): number {
   if (value === null || value === undefined) return 0;
   const parsed = Number(value);
   return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Start of the window the series covers, as epoch milliseconds.
 *
 * Fixed ranges look back a fixed distance from `now`; 'all' starts at the
 * wallet's first recorded activity. Returns `null` when the wallet has no
 * recorded activity at all (empty history).
 */
async function resolveWindowStart(
   wallet: string,
   range: PortfolioHistoryRange,
   nowMs: number
): Promise<number | null> {
   const windowMs = RANGE_WINDOW_MS[range];
   if (windowMs !== null) {
      return nowMs - windowMs;
   }

   const [firstSnapshot, firstOwnership] = await Promise.all([
      prisma.walletHoldingSnapshot.findFirst({
         where: { ownerAddress: wallet },
         orderBy: { recordedAt: 'asc' },
         select: { recordedAt: true },
      }),
      prisma.keyOwnership.findFirst({
         where: { ownerAddress: wallet },
         orderBy: { createdAt: 'asc' },
         select: { createdAt: true },
      }),
   ]);

   const candidates = [
      firstSnapshot?.recordedAt?.getTime(),
      firstOwnership?.createdAt?.getTime(),
   ].filter((value): value is number => typeof value === 'number');

   if (candidates.length === 0) {
      return null;
   }
   return Math.min(...candidates);
}

/**
 * Build the value-over-time series for a wallet.
 *
 * Served through {@link getPortfolioHistory}, which caches the result for
 * 5 minutes per wallet per range.
 */
export async function computePortfolioHistory(
   wallet: string,
   range: PortfolioHistoryRange,
   now: Date = new Date()
): Promise<PortfolioHistoryResult> {
   const intervalMs = RANGE_INTERVAL_MS[range];
   const nowMs = now.getTime();

   const windowStartMs = await resolveWindowStart(wallet, range, nowMs);
   if (windowStartMs === null) {
      return emptyHistory(wallet, range);
   }
   const windowStart = new Date(windowStartMs);

   const [snapshotRows, ownershipRows] = await Promise.all([
      prisma.walletHoldingSnapshot.findMany({
         where: {
            ownerAddress: wallet,
            recordedAt: { gte: windowStart, lte: now },
         },
         orderBy: { recordedAt: 'desc' },
         take: MAX_SNAPSHOT_ROWS,
         select: {
            creatorId: true,
            balance: true,
            recordedAt: true,
         },
      }),
      prisma.keyOwnership.findMany({
         where: { ownerAddress: wallet },
         select: { creatorId: true, balance: true, createdAt: true },
      }),
   ]);

   if (snapshotRows.length === 0 && ownershipRows.length === 0) {
      return emptyHistory(wallet, range);
   }

   if (snapshotRows.length >= MAX_SNAPSHOT_ROWS) {
      logger.warn(
         {
            type: 'portfolio_history_snapshot_cap_hit',
            wallet,
            range,
            cap: MAX_SNAPSHOT_ROWS,
         },
         'portfolio-history: holding snapshot scan hit its row cap; earliest snapshots were dropped'
      );
   }

   // Current position rows seed both the creator set and the pre-window
   // baseline lookups below.
   const ownershipByCreator = new Map<
      string,
      { currentBalance: number; createdAt: number }
   >();
   for (const row of ownershipRows) {
      ownershipByCreator.set(row.creatorId, {
         currentBalance: toNumber(row.balance),
         createdAt: row.createdAt.getTime(),
      });
   }

   const snapshotsByCreator = new Map<string, TimedValue[]>();
   for (const row of snapshotRows) {
      const list = snapshotsByCreator.get(row.creatorId) ?? [];
      list.push({ at: row.recordedAt.getTime(), value: toNumber(row.balance) });
      snapshotsByCreator.set(row.creatorId, list);
   }
   // Query returned newest-first; timelines must be ascending.
   for (const list of snapshotsByCreator.values()) {
      list.sort((a, b) => a.at - b.at);
   }

   // Series contributors: every key with a snapshot inside the window (its
   // balance may have been non-zero before it was sold) plus every key the
   // wallet currently holds. Fully closed positions with no recorded
   // movement in the window contribute zero, so they are left out to keep
   // the baseline price lookups below bounded by live positions.
   const creatorIds = [
      ...new Set([
         ...snapshotsByCreator.keys(),
         ...[...ownershipByCreator.entries()]
            .filter(([, ownership]) => ownership.currentBalance > 0)
            .map(([creatorId]) => creatorId),
      ]),
   ];

   if (creatorIds.length === 0) {
      // Nothing was ever held in this window (e.g. only long-closed
      // positions that predate snapshot recording): report no history
      // instead of a flat zero series.
      return emptyHistory(wallet, range);
   }

   // Baseline: the last snapshot before the window, only for positions that
   // already existed when the window opens (a row created inside the window
   // means the wallet held nothing before it).
   const baselineIds = creatorIds.filter(creatorId => {
      const ownership = ownershipByCreator.get(creatorId);
      return ownership !== undefined && ownership.createdAt <= windowStartMs;
   });
   const baselineSnapshots = await Promise.all(
      baselineIds.map(creatorId =>
         prisma.walletHoldingSnapshot.findFirst({
            where: {
               ownerAddress: wallet,
               creatorId,
               recordedAt: { lt: windowStart },
            },
            orderBy: { recordedAt: 'desc' },
            select: { balance: true, recordedAt: true },
         })
      )
   );
   baselineSnapshots.forEach((row, index) => {
      if (!row) return;
      const creatorId = baselineIds[index];
      const list = snapshotsByCreator.get(creatorId) ?? [];
      list.push({ at: row.recordedAt.getTime(), value: toNumber(row.balance) });
      list.sort((a, b) => a.at - b.at);
      snapshotsByCreator.set(creatorId, list);
   });

   const holdingTimelines = new Map<string, HoldingTimeline>();
   for (const creatorId of creatorIds) {
      const ownership = ownershipByCreator.get(creatorId);
      holdingTimelines.set(creatorId, {
         snapshots: snapshotsByCreator.get(creatorId) ?? [],
         currentBalance: ownership?.currentBalance,
         createdAt: ownership?.createdAt,
      });
   }

   // Points: anchored at `now`, stepping backwards by one interval.
   const spanMs = Math.max(0, nowMs - windowStartMs);
   let steps = Math.max(1, Math.ceil(spanMs / intervalMs));
   if (steps + 1 > MAX_POINTS) {
      logger.warn(
         {
            type: 'portfolio_history_point_cap_hit',
            wallet,
            range,
            requested_points: steps + 1,
            cap: MAX_POINTS,
         },
         'portfolio-history: series clamped to the maximum point count'
      );
      steps = MAX_POINTS - 1;
   }
   const pointTimes: number[] = [];
   for (let i = 0; i <= steps; i++) {
      pointTimes.push(nowMs - (steps - i) * intervalMs);
   }

   // Prices: in-window rows for every creator in the series plus each
   // creator's last price before the window, so the earliest points are
   // valued instead of falling back to zero.
   const [priceRows, priorPriceRows] = await Promise.all([
      prisma.creatorPriceHistory.findMany({
         where: {
            creatorId: { in: creatorIds },
            recordedAt: { gte: windowStart, lte: now },
         },
         orderBy: { recordedAt: 'desc' },
         take: MAX_PRICE_ROWS,
         select: { creatorId: true, price: true, recordedAt: true },
      }),
      Promise.all(
         creatorIds.map(creatorId =>
            prisma.creatorPriceHistory.findFirst({
               where: { creatorId, recordedAt: { lte: windowStart } },
               orderBy: { recordedAt: 'desc' },
               select: { price: true, recordedAt: true },
            })
         )
      ),
   ]);

   if (priceRows.length >= MAX_PRICE_ROWS) {
      logger.warn(
         {
            type: 'portfolio_history_price_cap_hit',
            wallet,
            range,
            cap: MAX_PRICE_ROWS,
         },
         'portfolio-history: price scan hit its row cap; earliest prices were dropped'
      );
   }

   const pricesByCreator = new Map<string, TimedValue[]>();
   const addPrice = (
      creatorId: string,
      recordedAt: Date,
      priceStroops: unknown
   ) => {
      const list = pricesByCreator.get(creatorId) ?? [];
      list.push({ at: recordedAt.getTime(), value: toXlm(priceStroops) });
      pricesByCreator.set(creatorId, list);
   };

   // Prior rows sort before every in-window row (both are <= / >= windowStart).
   priorPriceRows.forEach((row, index) => {
      if (row) {
         addPrice(creatorIds[index], row.recordedAt, row.price);
      }
   });
   for (const row of priceRows) {
      addPrice(row.creatorId, row.recordedAt, row.price);
   }
   for (const list of pricesByCreator.values()) {
      list.sort((a, b) => a.at - b.at);
   }

   // Live price fallback only for creators with no recorded price at all.
   const missingPriceIds = creatorIds.filter(
      creatorId => (pricesByCreator.get(creatorId)?.length ?? 0) === 0
   );
   const currentPrices = new Map<string, number>();
   if (missingPriceIds.length > 0) {
      const priceSnapshots = await prisma.creatorPriceSnapshot.findMany({
         where: { creatorId: { in: missingPriceIds } },
         select: { creatorId: true, currentPrice: true },
      });
      for (const snapshot of priceSnapshots) {
         currentPrices.set(
            snapshot.creatorId,
            toXlm(snapshot.currentPrice)
         );
      }
   }

   const points: PortfolioHistoryPoint[] = pointTimes.map(t => {
      let total = 0;
      for (const creatorId of creatorIds) {
         const balance = balanceAsOf(holdingTimelines.get(creatorId)!, t);
         if (balance === 0) continue;
         const priceXlm = priceAsOf(
            pricesByCreator.get(creatorId) ?? [],
            t,
            currentPrices.get(creatorId)
         );
         if (priceXlm === 0) continue;
         total += balance * priceXlm;
      }
      return { timestamp: new Date(t).toISOString(), value: round7(total) };
   });

   const firstValue = points[0]?.value ?? 0;
   const lastValue = points[points.length - 1]?.value ?? 0;
   const percentageReturn =
      points.length >= 2 && firstValue > 0
         ? round4(((lastValue - firstValue) / firstValue) * 100)
         : null;

   return {
      wallet,
      range,
      interval: RANGE_INTERVAL[range],
      intervalMs,
      currency: 'XLM',
      points,
      firstValue,
      lastValue,
      percentageReturn,
   };
}

/**
 * Cached read of the portfolio history series: 5-minute TTL keyed by wallet
 * and range. A cache miss falls through to {@link computePortfolioHistory}.
 */
export async function getPortfolioHistory(
   wallet: string,
   range: PortfolioHistoryRange,
   now: Date = new Date()
): Promise<PortfolioHistoryResult> {
   const cacheKey = portfolioHistoryCacheKey(wallet, range);
   const cached = await cacheGetJson<PortfolioHistoryResult>(cacheKey);
   if (cached) {
      return cached;
   }

   const result = await computePortfolioHistory(wallet, range, now);
   await cacheSetJson(
      cacheKey,
      result,
      PORTFOLIO_HISTORY_CACHE_TTL_SECONDS
   );
   return result;
}
