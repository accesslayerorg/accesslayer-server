import { prisma } from '../../utils/prisma.utils';
import { cacheGet, cacheSet } from '../../utils/redis.utils';
import { HeatmapRange } from './activity-heatmap.schemas';

export const HEATMAP_CACHE_TTL_SECONDS = 300; // 5 minutes

export interface HeatmapCell {
   weekday: number; // 0 (Sun) .. 6 (Sat)
   hour: number; // 0 .. 23
   trades: number;
   volume: number;
}

export interface ActivityHeatmapResult {
   keyId: string;
   range: HeatmapRange;
   timezone: string;
   totalTrades: number;
   totalVolume: number;
   busiestSlot: HeatmapCell;
   matrix: HeatmapCell[][];
}

const WEEKDAY_MAP: Record<string, number> = {
   Sun: 0,
   Mon: 1,
   Tue: 2,
   Wed: 3,
   Thu: 4,
   Fri: 5,
   Sat: 6,
};

function round7(value: number): number {
   return Math.round(value * 10_000_000) / 10_000_000;
}

/**
 * Converts a UTC instant to `(weekday, hour)` in the requested IANA timezone,
 * accurately respecting daylight saving time transitions.
 */
export function toZonedWeekdayAndHour(
   utcDate: Date,
   timeZone: string
): { weekday: number; hour: number } {
   const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      hourCycle: 'h23',
   });
   const parts = formatter.formatToParts(utcDate);
   const weekdayStr = parts.find(p => p.type === 'weekday')?.value ?? 'Sun';
   const hourStr = parts.find(p => p.type === 'hour')?.value ?? '0';

   const weekday = WEEKDAY_MAP[weekdayStr] ?? 0;
   const parsedHour = Number.parseInt(hourStr, 10);
   const hour = Number.isFinite(parsedHour) ? parsedHour % 24 : 0;

   return { weekday, hour };
}

export function buildHeatmapCacheKey(
   keyId: string,
   range: HeatmapRange,
   tz: string
): string {
   return `keys:heatmap:${keyId}:${range}:${tz}`;
}

export async function getActivityHeatmap(
   keyId: string,
   range: HeatmapRange,
   tz: string,
   now: Date = new Date()
): Promise<ActivityHeatmapResult> {
   const cacheKey = buildHeatmapCacheKey(keyId, range, tz);
   const cached = await cacheGet(cacheKey);
   if (cached) {
      try {
         return JSON.parse(cached) as ActivityHeatmapResult;
      } catch {
         // Fall through to recompute on corrupted cache entry
      }
   }

   const rangeStart = new Date(now.getTime() - range * 24 * 60 * 60 * 1000);

   const stats = await prisma.tradeHourlyStat.findMany({
      where: {
         keyId,
         bucketStart: {
            gte: rangeStart,
            lte: now,
         },
      },
      select: {
         bucketStart: true,
         trades: true,
         volume: true,
      },
   });

   const matrix: HeatmapCell[][] = Array.from({ length: 7 }, (_, weekday) =>
      Array.from({ length: 24 }, (_, hour) => ({
         weekday,
         hour,
         trades: 0,
         volume: 0,
      }))
   );

   let totalTrades = 0;
   let totalVolume = 0;

   for (const stat of stats) {
      const { weekday, hour } = toZonedWeekdayAndHour(stat.bucketStart, tz);
      const cell = matrix[weekday][hour];
      const vol = Number(stat.volume ?? 0);

      cell.trades += stat.trades;
      cell.volume = round7(cell.volume + vol);

      totalTrades += stat.trades;
      totalVolume = round7(totalVolume + vol);
   }

   let busiestSlot: HeatmapCell = matrix[0][0];
   for (let d = 0; d < 7; d++) {
      for (let h = 0; h < 24; h++) {
         const cell = matrix[d][h];
         if (
            cell.trades > busiestSlot.trades ||
            (cell.trades === busiestSlot.trades &&
               cell.volume > busiestSlot.volume)
         ) {
            busiestSlot = cell;
         }
      }
   }

   const result: ActivityHeatmapResult = {
      keyId,
      range,
      timezone: tz,
      totalTrades,
      totalVolume,
      busiestSlot: { ...busiestSlot },
      matrix,
   };

   await cacheSet(cacheKey, JSON.stringify(result), HEATMAP_CACHE_TTL_SECONDS);

   return result;
}
