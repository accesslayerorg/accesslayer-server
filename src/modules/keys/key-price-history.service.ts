import { prisma } from '../../utils/prisma.utils';

export const PRICE_HISTORY_INTERVALS = ['1h', '24h', '7d'] as const;
export type PriceHistoryInterval = (typeof PRICE_HISTORY_INTERVALS)[number];

const intervalMs: Record<PriceHistoryInterval, number> = {
   '1h': 60 * 60 * 1000,
   '24h': 24 * 60 * 60 * 1000,
   '7d': 7 * 24 * 60 * 60 * 1000,
};

export async function getKeyPriceHistory(
   creatorId: string,
   from: Date,
   to: Date,
   interval: PriceHistoryInterval
) {
   const snapshots = await prisma.creatorPriceHistory.findMany({
      where: { creatorId, recordedAt: { gte: from, lte: to } },
      orderBy: { recordedAt: 'asc' },
   });
   const buckets = new Map<number, (typeof snapshots)[number]>();
   for (const snapshot of snapshots) {
      const bucket =
         Math.floor(snapshot.recordedAt.getTime() / intervalMs[interval]) *
         intervalMs[interval];
      buckets.set(bucket, snapshot);
   }
   return Array.from(buckets.entries())
      .slice(0, 500)
      .map(([timestamp, snapshot]) => ({
         timestamp: new Date(timestamp),
         price: snapshot.price,
      }));
}
