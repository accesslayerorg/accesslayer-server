import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson, cacheInvalidate } from '../../utils/redis.utils';
import { logger } from '../../utils/logger.utils';
import {
   REDIS_KEYS,
   KEY_SNAPSHOTS_CACHE_TTL_SECONDS,
} from '../../constants/notifications.constants';
import { KeyNotFoundError } from './key-fees.service';

export { KeyNotFoundError };

export interface KeySnapshotItem {
   date: string;
   price: string;
   volume: string;
   holder_count: number;
   market_cap: string;
}

export type SnapshotRange = '7d' | '30d' | '90d' | 'all';

function parseRangeCutoff(range: string): Date | null {
   const now = Date.now();
   switch (range.toLowerCase()) {
      case '7d':
         return new Date(now - 7 * 24 * 60 * 60 * 1000);
      case '30d':
         return new Date(now - 30 * 24 * 60 * 60 * 1000);
      case '90d':
         return new Date(now - 90 * 24 * 60 * 60 * 1000);
      case 'all':
      default:
         return null;
   }
}

/**
 * Returns historical metric snapshots for a key filtered by range (#1112).
 * Cached for 5 minutes (300s).
 */
export async function getKeySnapshots(
   keyId: string,
   range: string = 'all'
): Promise<KeySnapshotItem[]> {
   const normalizedRange = ['7d', '30d', '90d', 'all'].includes(range.toLowerCase())
      ? range.toLowerCase()
      : 'all';

   const cacheKey = REDIS_KEYS.keySnapshots(keyId, normalizedRange);
   const cached = await cacheGetJson<KeySnapshotItem[]>(cacheKey);
   if (cached !== null) {
      return cached;
   }

   const creator = await prisma.creatorProfile.findFirst({
      where: { OR: [{ id: keyId }, { handle: keyId }] },
      select: { id: true },
   });

   if (!creator) {
      throw new KeyNotFoundError(keyId);
   }

   const targetKeyId = creator.id;
   const cutoff = parseRangeCutoff(normalizedRange);

   const rows = await (prisma as any).keySnapshot.findMany({
      where: {
         keyId: targetKeyId,
         ...(cutoff ? { date: { gte: cutoff } } : {}),
      },
      orderBy: { date: 'asc' },
   });

   const result: KeySnapshotItem[] = rows.map((r: any) => ({
      date: r.date ? new Date(r.date).toISOString() : new Date().toISOString(),
      price: r.price.toString(),
      volume: r.volume.toString(),
      holder_count: r.holderCount,
      market_cap: r.marketCap.toString(),
   }));

   await cacheSetJson(cacheKey, result, KEY_SNAPSHOTS_CACHE_TTL_SECONDS);
   return result;
}

/**
 * Invalidates cached snapshots across all ranges for a key (#1112).
 */
export async function invalidateKeySnapshotsCache(keyId: string): Promise<void> {
   try {
      const ranges = ['7d', '30d', '90d', 'all'];
      await Promise.all(
         ranges.map(r => cacheInvalidate(REDIS_KEYS.keySnapshots(keyId, r)))
      );
   } catch (error) {
      logger.warn({ error, keyId }, 'Failed to invalidate key snapshots cache');
   }
}
