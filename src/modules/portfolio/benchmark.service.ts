// src/modules/portfolio/benchmark.service.ts
// Benchmark series service (#1321): computes normalized (base 100) daily
// series for equal-weight market basket, top 10 by volume, and XLM, cached
// in Redis for 15 minutes.

import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';
import {
   buildDailyPriceSeries,
   buildUtcDayList,
   PERFORMANCE_RANGE_DAYS,
   PerformanceRange,
} from './returns.service';

export const BENCHMARK_CACHE_TTL_SECONDS = 15 * 60;
const STROOPS_PER_XLM = 10_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface BenchmarkPoint {
   date: string;
   value: number;
   priceCarriedForward: boolean;
}

export interface BenchmarkSeriesResult {
   range: PerformanceRange;
   equalWeightMarket: BenchmarkPoint[];
   top10Volume: BenchmarkPoint[];
   xlm: BenchmarkPoint[];
   returnsPct: {
      equalWeightMarket: number;
      top10Volume: number;
      xlm: number;
   };
}

interface BenchmarkDb {
   creatorProfile: {
      findMany: (args: any) => Promise<
         Array<{ id: string; circulatingSupply: unknown }>
      >;
   };
   creatorPriceHistory: {
      findMany: (args: any) => Promise<
         Array<{ creatorId: string; price: bigint | number; recordedAt: Date }>
      >;
   };
   activity: {
      groupBy: (args: any) => Promise<
         Array<{ creatorId: string | null; _count: { _all: number } }>
      >;
   };
}

function round4(n: number): number {
   return Number(n.toFixed(4));
}

export function buildEqualWeightBasketSeries(
   days: string[],
   keyIds: string[],
   groupedPrices: Map<string, Array<{ priceXlm: number; recordedAt: Date }>>
): BenchmarkPoint[] {
   if (days.length === 0) return [];
   if (keyIds.length === 0) {
      return days.map((date) => ({
         date,
         value: 100,
         priceCarriedForward: false,
      }));
   }

   const dailyByKey = new Map(
      keyIds.map((id) => [
         id,
         buildDailyPriceSeries(days, groupedPrices.get(id) ?? []),
      ])
   );

   // Determine each key's base price at the earliest day it has a price
   const basePriceByKey = new Map<string, number>();
   for (const id of keyIds) {
      const series = dailyByKey.get(id)!;
      for (const day of days) {
         const pt = series.get(day);
         if (pt && pt.priceXlm > 0) {
            basePriceByKey.set(id, pt.priceXlm);
            break;
         }
      }
   }

   const points: BenchmarkPoint[] = [];
   for (let idx = 0; idx < days.length; idx++) {
      const day = days[idx];
      if (idx === 0) {
         points.push({ date: day, value: 100, priceCarriedForward: false });
         continue;
      }

      let sumNormalized = 0;
      let count = 0;
      let carriedForward = false;

      for (const id of keyIds) {
         const base = basePriceByKey.get(id);
         const pt = dailyByKey.get(id)?.get(day);
         if (base && base > 0 && pt) {
            sumNormalized += (pt.priceXlm / base) * 100;
            count++;
            if (pt.carriedForward) carriedForward = true;
         }
      }

      points.push({
         date: day,
         value: count > 0 ? round4(sumNormalized / count) : 100,
         priceCarriedForward: carriedForward,
      });
   }

   return points;
}

export class BenchmarkService {
   private get db(): BenchmarkDb {
      return prisma as unknown as BenchmarkDb;
   }

   async series(
      range: PerformanceRange = '30d',
      now: Date = new Date()
   ): Promise<BenchmarkSeriesResult> {
      const cacheKey = `benchmark:series:v1:${range}`;
      const cached = await cacheGetJson<BenchmarkSeriesResult>(cacheKey);
      if (cached) {
         return cached;
      }

      const rangeDays = PERFORMANCE_RANGE_DAYS[range] ?? 90;
      const startDate = new Date(now.getTime() - rangeDays * DAY_MS);
      const days = buildUtcDayList(startDate, now);

      const [profiles, volumeGroups] = await Promise.all([
         this.db.creatorProfile.findMany({
            where: { status: 'Active' },
            select: { id: true, circulatingSupply: true },
            take: 200,
         }),
         this.db.activity
            .groupBy({
               by: ['creatorId'],
               where: {
                  type: { in: ['KEY_BOUGHT', 'KEY_SOLD'] },
                  createdAt: { gte: startDate, lte: now },
               },
               _count: { _all: true },
               orderBy: { _count: { creatorId: 'desc' } },
               take: 10,
            })
            .catch(() => []),
      ]);

      const allKeyIds = profiles.map((p) => p.id);
      const top10FromVolume = volumeGroups
         .map((g) => g.creatorId)
         .filter((id): id is string => Boolean(id));
      const top10KeyIds =
         top10FromVolume.length > 0
            ? top10FromVolume.slice(0, 10)
            : [...profiles]
                 .sort(
                    (a, b) =>
                       Number(b.circulatingSupply) - Number(a.circulatingSupply)
                 )
                 .slice(0, 10)
                 .map((p) => p.id);

      const combinedIds = Array.from(new Set([...allKeyIds, ...top10KeyIds]));
      const priceRows =
         combinedIds.length > 0
            ? await this.db.creatorPriceHistory.findMany({
                 where: {
                    creatorId: { in: combinedIds },
                    recordedAt: { lte: now },
                 },
                 orderBy: { recordedAt: 'asc' },
              })
            : [];

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

      const equalWeightMarket = buildEqualWeightBasketSeries(
         days,
         allKeyIds,
         groupedPrices
      );
      const top10Volume = buildEqualWeightBasketSeries(
         days,
         top10KeyIds,
         groupedPrices
      );
      const xlm: BenchmarkPoint[] = days.map((date) => ({
         date,
         value: 100,
         priceCarriedForward: false,
      }));

      const lastReturn = (pts: BenchmarkPoint[]): number =>
         pts.length > 0 ? round4(pts[pts.length - 1].value - 100) : 0;

      const result: BenchmarkSeriesResult = {
         range,
         equalWeightMarket,
         top10Volume,
         xlm,
         returnsPct: {
            equalWeightMarket: lastReturn(equalWeightMarket),
            top10Volume: lastReturn(top10Volume),
            xlm: 0,
         },
      };

      await cacheSetJson(cacheKey, result, BENCHMARK_CACHE_TTL_SECONDS);
      return result;
   }
}

export const benchmarkService = new BenchmarkService();
