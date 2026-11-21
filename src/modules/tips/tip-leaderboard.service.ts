import { Decimal } from '@prisma/client/runtime/library';
import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';
import { resolveTipKeyId } from './tips.service';

export const TIP_LEADERBOARD_CACHE_TTL_SECONDS = 300;

export interface TipLeaderboardItem {
   rank: number;
   wallet: string | null;
   total_tipped: string;
   tip_count: number;
   anonymous: boolean;
}

export async function getTipLeaderboard(
   keyId: string,
   limit: number
): Promise<TipLeaderboardItem[]> {
   const canonicalKeyId = await resolveTipKeyId(keyId);
   // The existing TipSent invalidation wildcard covers this cache as well.
   const cacheKey = `key:tips:${canonicalKeyId}:leaderboard:${limit}`;
   const cached = await cacheGetJson<TipLeaderboardItem[]>(cacheKey);
   if (cached !== null) return cached;

   // Keep anonymous and public amounts separate even for the same sender.
   const rows = await prisma.keyTip.groupBy({
      by: ['tipper', 'anonymous'],
      where: { keyId: canonicalKeyId },
      _sum: { amount: true },
      _count: { _all: true },
      orderBy: [{ _sum: { amount: 'desc' } }, { tipper: 'asc' }, { anonymous: 'asc' }],
      take: limit,
   });
   const result = rows.map((row, index) => ({
      rank: index + 1,
      wallet: row.anonymous ? null : row.tipper.slice(0, 6) + '…' + row.tipper.slice(-4),
      anonymous: row.anonymous,
      total_tipped: new Decimal(row._sum.amount ?? 0).toFixed(7),
      tip_count: row._count._all,
   }));
   await cacheSetJson(cacheKey, result, TIP_LEADERBOARD_CACHE_TTL_SECONDS);
   return result;
}
