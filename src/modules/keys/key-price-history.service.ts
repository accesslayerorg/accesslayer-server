import { prisma } from '../../utils/prisma.utils';

export const PRICE_HISTORY_INTERVALS = ['1h', '24h', '7d'] as const;
export type PriceHistoryInterval = (typeof PRICE_HISTORY_INTERVALS)[number];

const intervalMs: Record<PriceHistoryInterval, number> = {
   '1h': 60 * 60 * 1000,
   '24h': 24 * 60 * 60 * 1000,
   '7d': 7 * 24 * 60 * 60 * 1000,
};

// Hard cap on rows returned by the raw range query. Protects the
// query-performance acceptance criterion (<100ms for a 30-day range) and
// keeps response payloads bounded even for very high-volume keys (#893).
const MAX_RAW_SNAPSHOTS = 5000;

export interface PriceSnapshotPoint {
   timestamp: Date;
   price: bigint;
   supply: bigint;
   direction: 'BUY' | 'SELL';
}

/**
 * Returns raw price snapshots for a key within [from, to], ordered oldest
 * first. This is the shape TWAP calculations and historical price charts
 * need — every recorded trade price/supply/direction point, not a
 * downsampled average (#893).
 *
 * Relies on the composite index on (creatorId, recordedAt) for fast range
 * scans.
 */
export async function getKeyPriceSnapshots(
   creatorId: string,
   from: Date,
   to: Date
): Promise<PriceSnapshotPoint[]> {
   const snapshots = await prisma.creatorPriceHistory.findMany({
      where: { creatorId, recordedAt: { gte: from, lte: to } },
      orderBy: { recordedAt: 'asc' },
      take: MAX_RAW_SNAPSHOTS,
      select: { recordedAt: true, price: true, supply: true, direction: true },
   });

   return snapshots.map((snapshot: { recordedAt: Date; price: bigint; supply: bigint; direction: string }) => ({
      timestamp: snapshot.recordedAt,
      price: snapshot.price,
      supply: snapshot.supply,
      direction: snapshot.direction as 'BUY' | 'SELL',
   }));
}

/**
 * Returns price history downsampled into fixed-width buckets (one snapshot
 * per bucket — the last one observed in that bucket). Kept for callers that
 * want a chart-friendly, fixed-cardinality series rather than every raw
 * trade point.
 */
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
      const bucket = Math.floor(snapshot.recordedAt.getTime() / intervalMs[interval]) * intervalMs[interval];
      buckets.set(bucket, snapshot);
   }
   return Array.from(buckets.entries())
      .slice(0, 500)
      .map(([timestamp, snapshot]) => ({ timestamp: new Date(timestamp), price: snapshot.price }));
}
