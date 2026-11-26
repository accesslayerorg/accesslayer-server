import { prisma } from '../utils/prisma.utils';
import { logger } from '../utils/logger.utils';

const HOUR_MS = 60 * 60 * 1000;

export function floorToUtcHour(date: Date): Date {
   return new Date(
      Date.UTC(
         date.getUTCFullYear(),
         date.getUTCMonth(),
         date.getUTCDate(),
         date.getUTCHours(),
         0,
         0,
         0
      )
   );
}

function round7(value: number): number {
   return Math.round(value * 10_000_000) / 10_000_000;
}

export interface HourlyBucketAggregate {
   keyId: string;
   bucketStart: Date;
   trades: number;
   volume: number;
}

export class HourlyAggregator {
   /**
    * Aggregates trades in `[fromInclusive, toExclusive)` into hourly buckets
    * per key and upserts them idempotently into `TradeHourlyStat`.
    */
   static async aggregateRange(
      fromInclusive: Date,
      toExclusive: Date
   ): Promise<HourlyBucketAggregate[]> {
      const trades = await prisma.trade.findMany({
         where: {
            timestamp: {
               gte: fromInclusive,
               lt: toExclusive,
            },
         },
         select: {
            creatorId: true,
            quantity: true,
            price: true,
            timestamp: true,
         },
      });

      const buckets = new Map<string, HourlyBucketAggregate>();

      for (const trade of trades) {
         const bucketStart = floorToUtcHour(trade.timestamp);
         const mapKey = `${trade.creatorId}::${bucketStart.toISOString()}`;
         const qty = Number(trade.quantity);
         const price = Number(trade.price);
         const tradeVolume =
            Number.isFinite(qty) && Number.isFinite(price) ? qty * price : 0;

         const existing = buckets.get(mapKey);
         if (existing) {
            existing.trades += 1;
            existing.volume = round7(existing.volume + tradeVolume);
         } else {
            buckets.set(mapKey, {
               keyId: trade.creatorId,
               bucketStart,
               trades: 1,
               volume: round7(tradeVolume),
            });
         }
      }

      const results = Array.from(buckets.values());

      for (const bucket of results) {
         await prisma.tradeHourlyStat.upsert({
            where: {
               keyId_bucketStart: {
                  keyId: bucket.keyId,
                  bucketStart: bucket.bucketStart,
               },
            },
            create: {
               keyId: bucket.keyId,
               bucketStart: bucket.bucketStart,
               trades: bucket.trades,
               volume: bucket.volume,
            },
            update: {
               trades: bucket.trades,
               volume: bucket.volume,
            },
         });
      }

      return results;
   }

   /**
    * Updates the current and previous UTC hour buckets from recent trades.
    */
   static async runLive(now: Date = new Date()): Promise<HourlyBucketAggregate[]> {
      const currentHour = floorToUtcHour(now);
      const previousHour = new Date(currentHour.getTime() - HOUR_MS);
      const nextHour = new Date(currentHour.getTime() + HOUR_MS);

      const results = await HourlyAggregator.aggregateRange(previousHour, nextHour);
      logger.info(
         {
            type: 'hourly_aggregator_live',
            previousHour: previousHour.toISOString(),
            currentHour: currentHour.toISOString(),
            bucketsUpdated: results.length,
         },
         'Hourly activity aggregation completed'
      );
      return results;
   }

   /**
    * Idempotently backfills historical hourly stats across `[from, to]`.
    */
   static async backfill(
      from: Date,
      to: Date
   ): Promise<HourlyBucketAggregate[]> {
      const start = floorToUtcHour(from);
      const endExclusive = new Date(floorToUtcHour(to).getTime() + HOUR_MS);
      return HourlyAggregator.aggregateRange(start, endExclusive);
   }
}
