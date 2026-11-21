// src/modules/keys/key-snapshots.service.ts
//
// Read side of GET /keys/:key_id/snapshots (#1112). Serves daily analytics
// snapshots from `key_snapshots`, oldest first (chart order), fronted by a
// 5-minute cache that the SnapshotTaken indexer invalidates per key.

import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';
import {
   KEY_SNAPSHOT_CACHE_TTL_SECONDS,
   KEY_SNAPSHOT_RANGE_DAYS,
   keySnapshotCacheKey,
   type KeySnapshotRange,
} from '../../constants/redis.constants';

export interface KeySnapshotDto {
   /** UTC day, YYYY-MM-DD. */
   date: string;
   /** Stroops, as strings to avoid JS precision loss. */
   price: string;
   volume: string;
   holder_count: number;
   market_cap: string;
}

/**
 * First UTC day included in `range`, counting today as day one
 * (7d = today and the six days before). `null` for `all`.
 */
export function rangeStartDate(
   range: KeySnapshotRange,
   now: Date = new Date()
): Date | null {
   if (range === 'all') return null;
   const days = KEY_SNAPSHOT_RANGE_DAYS[range];
   return new Date(
      Date.UTC(
         now.getUTCFullYear(),
         now.getUTCMonth(),
         now.getUTCDate() - (days - 1)
      )
   );
}

/**
 * Daily snapshots for a key within `range`, oldest first. Returns an empty
 * array for a key with no snapshots yet; that result is cached too.
 *
 * `creatorId` must already be the canonical CreatorProfile id (not a
 * handle) so the cache key matches what the indexer invalidates.
 */
export async function getKeySnapshots(
   creatorId: string,
   range: KeySnapshotRange,
   now: Date = new Date()
): Promise<KeySnapshotDto[]> {
   const cacheKey = keySnapshotCacheKey(creatorId, range);
   const cached = await cacheGetJson<KeySnapshotDto[]>(cacheKey);
   if (cached !== null) {
      return cached;
   }

   const start = rangeStartDate(range, now);
   const rows = await prisma.keyAnalyticsSnapshot.findMany({
      where: {
         creatorId,
         ...(start ? { snapshotDate: { gte: start } } : {}),
      },
      orderBy: { snapshotDate: 'asc' },
      select: {
         snapshotDate: true,
         price: true,
         volume: true,
         holderCount: true,
         marketCap: true,
      },
   });

   const result: KeySnapshotDto[] = rows.map(row => ({
      date: row.snapshotDate.toISOString().slice(0, 10),
      price: row.price.toString(),
      volume: row.volume.toString(),
      holder_count: row.holderCount,
      market_cap: row.marketCap.toString(),
   }));

   await cacheSetJson(cacheKey, result, KEY_SNAPSHOT_CACHE_TTL_SECONDS);
   return result;
}
