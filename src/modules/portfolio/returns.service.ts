// src/modules/portfolio/returns.service.ts
// Time-weighted portfolio returns (TWR) service (#1321).
// Chains sub-period returns split at every balance-changing transfer so
// deposits and withdrawals do not distort portfolio performance.

import { prisma } from '../../utils/prisma.utils';

export const PERFORMANCE_RANGES = ['7d', '30d', '90d', '1y', 'all'] as const;
export type PerformanceRange = (typeof PERFORMANCE_RANGES)[number];

const DAY_MS = 24 * 60 * 60 * 1000;
const STROOPS_PER_XLM = 10_000_000;

export const PERFORMANCE_RANGE_DAYS: Record<PerformanceRange, number | null> = {
   '7d': 7,
   '30d': 30,
   '90d': 90,
   '1y': 365,
   all: null,
};

export interface BalanceCheckpointRecord {
   holder: string;
   keyId: string;
   ledger: number;
   balance: number;
   timestamp: Date;
}

export interface PriceRecord {
   creatorId: string;
   priceXlm: number;
   recordedAt: Date;
}

export interface DailyPricePoint {
   date: string;
   priceXlm: number;
   carriedForward: boolean;
}

export interface PortfolioPerformancePoint {
   date: string;
   value: number;
   portfolioValueXlm: number;
   priceCarriedForward: boolean;
}

export interface TimeWeightedReturnsResult {
   wallet: string;
   range: PerformanceRange;
   series: PortfolioPerformancePoint[];
   totalReturnPct: number;
   hasPriceCarryForward: boolean;
}

export function toUtcDateKey(date: Date): string {
   return date.toISOString().slice(0, 10);
}

export function buildUtcDayList(start: Date, end: Date): string[] {
   const days: string[] = [];
   const startMs = Date.UTC(
      start.getUTCFullYear(),
      start.getUTCMonth(),
      start.getUTCDate()
   );
   const endMs = Date.UTC(
      end.getUTCFullYear(),
      end.getUTCMonth(),
      end.getUTCDate()
   );
   for (let ms = startMs; ms <= endMs; ms += DAY_MS) {
      days.push(new Date(ms).toISOString().slice(0, 10));
   }
   return days;
}

/**
 * Builds daily prices for a key across `days`, carrying the last known price
 * forward on days with no recorded trades and flagging `carriedForward: true`.
 */
export function buildDailyPriceSeries(
   days: string[],
   prices: Array<{ priceXlm: number; recordedAt: Date }>
): Map<string, DailyPricePoint> {
   const sorted = [...prices].sort(
      (a, b) => a.recordedAt.getTime() - b.recordedAt.getTime()
   );
   const byDay = new Map<string, number>();
   for (const p of sorted) {
      byDay.set(toUtcDateKey(p.recordedAt), p.priceXlm);
   }

   const firstDay = days[0];
   let lastKnownPrice: number | null = null;
   if (firstDay) {
      for (const p of sorted) {
         if (toUtcDateKey(p.recordedAt) < firstDay) {
            lastKnownPrice = p.priceXlm;
         } else {
            break;
         }
      }
   }

   const result = new Map<string, DailyPricePoint>();
   for (const day of days) {
      const exact = byDay.get(day);
      if (exact !== undefined) {
         lastKnownPrice = exact;
         result.set(day, { date: day, priceXlm: exact, carriedForward: false });
      } else if (lastKnownPrice !== null) {
         result.set(day, {
            date: day,
            priceXlm: lastKnownPrice,
            carriedForward: true,
         });
      }
   }
   return result;
}

function round4(n: number): number {
   return Number(n.toFixed(4));
}

function round7(n: number): number {
   return Number(n.toFixed(7));
}

/**
 * Pure TWR computation over daily boundaries and intra-day balance-changing
 * checkpoints. Splits sub-periods at every balance change so cash flows
 * (deposits/withdrawals) are excluded from the return calculation.
 */
export function computeChainedTimeWeightedReturns(params: {
   days: string[];
   checkpoints: BalanceCheckpointRecord[];
   dailyPricesByKey: Map<string, Map<string, DailyPricePoint>>;
}): {
   series: PortfolioPerformancePoint[];
   totalReturnPct: number;
   hasPriceCarryForward: boolean;
} {
   const { days, checkpoints, dailyPricesByKey } = params;
   if (days.length === 0 || checkpoints.length === 0) {
      return { series: [], totalReturnPct: 0, hasPriceCarryForward: false };
   }

   const firstDay = days[0];
   const sortedCheckpoints = [...checkpoints].sort(
      (a, b) =>
         a.timestamp.getTime() - b.timestamp.getTime() || a.ledger - b.ledger
   );

   const balances = new Map<string, number>();
   const inRangeCheckpointsByDay = new Map<string, BalanceCheckpointRecord[]>();

   for (const cp of sortedCheckpoints) {
      const cpDay = toUtcDateKey(cp.timestamp);
      if (cpDay < firstDay) {
         balances.set(cp.keyId, cp.balance);
      } else {
         const list = inRangeCheckpointsByDay.get(cpDay) ?? [];
         list.push(cp);
         inRangeCheckpointsByDay.set(cpDay, list);
      }
   }

   const valuePortfolioOnDay = (
      day: string,
      balMap: Map<string, number>
   ): { valueXlm: number; carriedForward: boolean } => {
      let total = 0;
      let carriedForward = false;
      for (const [keyId, bal] of balMap.entries()) {
         if (bal <= 0) continue;
         const pricePoint = dailyPricesByKey.get(keyId)?.get(day);
         if (pricePoint) {
            total += bal * pricePoint.priceXlm;
            if (pricePoint.carriedForward) carriedForward = true;
         }
      }
      return { valueXlm: total, carriedForward };
   };

   // Apply any checkpoints that occurred on day 0 as opening positions if
   // the wallet had zero prior holdings.
   const day0Checkpoints = inRangeCheckpointsByDay.get(firstDay) ?? [];
   const hasPriorHoldings = Array.from(balances.values()).some((b) => b > 0);
   if (!hasPriorHoldings && day0Checkpoints.length > 0) {
      for (const cp of day0Checkpoints) {
         balances.set(cp.keyId, cp.balance);
      }
      inRangeCheckpointsByDay.delete(firstDay);
   }

   let twrFactor = 1;
   let hasPriceCarryForward = false;
   const series: PortfolioPerformancePoint[] = [];

   const day0Val = valuePortfolioOnDay(firstDay, balances);
   if (day0Val.carriedForward) hasPriceCarryForward = true;

   let prevVal = day0Val.valueXlm;
   series.push({
      date: firstDay,
      value: 100,
      portfolioValueXlm: round7(day0Val.valueXlm),
      priceCarriedForward: day0Val.carriedForward,
   });

   for (let i = 1; i < days.length; i++) {
      const day = days[i];
      const dayEvents = inRangeCheckpointsByDay.get(day) ?? [];

      // 1. Sub-period return from previous day close to current day valuation
      // BEFORE applying today's balance-changing transfers.
      const preFlowVal = valuePortfolioOnDay(day, balances);
      if (preFlowVal.carriedForward) hasPriceCarryForward = true;

      if (prevVal > 0) {
         const subReturn = (preFlowVal.valueXlm - prevVal) / prevVal;
         twrFactor *= 1 + subReturn;
      }

      // 2. Apply all balance-changing transfers for `day` (cash flows do not
      // affect TWR; they reset the capital base for the next sub-period).
      for (const cp of dayEvents) {
         balances.set(cp.keyId, cp.balance);
      }

      const postFlowVal = valuePortfolioOnDay(day, balances);
      if (postFlowVal.carriedForward) hasPriceCarryForward = true;
      prevVal = postFlowVal.valueXlm;

      series.push({
         date: day,
         value: round4(100 * twrFactor),
         portfolioValueXlm: round7(postFlowVal.valueXlm),
         priceCarriedForward: postFlowVal.carriedForward,
      });
   }

   const anyPositive = series.some((p) => p.portfolioValueXlm > 0);
   if (!anyPositive) {
      return { series: [], totalReturnPct: 0, hasPriceCarryForward: false };
   }

   return {
      series,
      totalReturnPct: round4((twrFactor - 1) * 100),
      hasPriceCarryForward,
   };
}

interface ReturnsDb {
   balanceCheckpoint: {
      findMany: (args: any) => Promise<
         Array<{
            holder: string;
            keyId: string;
            ledger: number;
            balance: unknown;
            timestamp: Date;
         }>
      >;
   };
   creatorPriceHistory: {
      findMany: (args: any) => Promise<
         Array<{ creatorId: string; price: bigint | number; recordedAt: Date }>
      >;
   };
}

export class ReturnsService {
   private get db(): ReturnsDb {
      return prisma as unknown as ReturnsDb;
   }

   async timeWeighted(
      wallet: string,
      range: PerformanceRange = '30d',
      now: Date = new Date()
   ): Promise<TimeWeightedReturnsResult> {
      const rawCheckpoints = await this.db.balanceCheckpoint.findMany({
         where: {
            holder: wallet,
            timestamp: { lte: now },
         },
         orderBy: [{ timestamp: 'asc' }, { ledger: 'asc' }],
      });

      if (rawCheckpoints.length === 0) {
         return {
            wallet,
            range,
            series: [],
            totalReturnPct: 0,
            hasPriceCarryForward: false,
         };
      }

      const checkpoints: BalanceCheckpointRecord[] = rawCheckpoints.map((c) => ({
         holder: c.holder,
         keyId: c.keyId,
         ledger: c.ledger,
         balance: Number(c.balance),
         timestamp: c.timestamp,
      }));

      const rangeDays = PERFORMANCE_RANGE_DAYS[range];
      const startDate =
         rangeDays !== null
            ? new Date(now.getTime() - rangeDays * DAY_MS)
            : checkpoints[0].timestamp;

      const days = buildUtcDayList(startDate, now);
      const keyIds = Array.from(new Set(checkpoints.map((c) => c.keyId)));

      const priceRows = await this.db.creatorPriceHistory.findMany({
         where: {
            creatorId: { in: keyIds },
            recordedAt: { lte: now },
         },
         orderBy: { recordedAt: 'asc' },
      });

      const groupedPrices = new Map<
         string,
         Array<{ priceXlm: number; recordedAt: Date }>
      >();
      for (const row of priceRows) {
         const list = groupedPrices.get(row.creatorId) ?? [];
         list.push({
            priceXlm: Number(row.price) / STROOPS_PER_XLM,
            recordedAt: row.recordedAt,
         });
         groupedPrices.set(row.creatorId, list);
      }

      const dailyPricesByKey = new Map<string, Map<string, DailyPricePoint>>();
      for (const keyId of keyIds) {
         dailyPricesByKey.set(
            keyId,
            buildDailyPriceSeries(days, groupedPrices.get(keyId) ?? [])
         );
      }

      const computed = computeChainedTimeWeightedReturns({
         days,
         checkpoints,
         dailyPricesByKey,
      });

      return {
         wallet,
         range,
         ...computed,
      };
   }
}

export const returnsService = new ReturnsService();
