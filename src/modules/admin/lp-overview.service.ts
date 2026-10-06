// src/modules/admin/lp-overview.service.ts
// Protocol-owned liquidity across all keys, aggregated from LpAllocation
// rows recorded by the LP allocation indexer (#943). Cached 60s; invalidated
// on every new LPAllocationSent event.
import { prisma } from '../../utils/prisma.utils';
import {
   cacheGetJson,
   cacheInvalidate,
   cacheSetJson,
} from '../../utils/redis.utils';

export const LP_OVERVIEW_CACHE_TTL_SECONDS = 60;
export const LP_OVERVIEW_CACHE_KEY = 'admin:lp-overview';

export interface LpOverview {
   /** Sum of all LP allocations recorded across every key, in XLM. */
   totalProtocolLpXlm: string;
   /** Number of distinct keys with at least one recorded LP allocation. */
   keyCount: number;
   /** Total number of LP allocation events recorded. */
   allocationCount: number;
}

export async function invalidateLpOverviewCache(): Promise<void> {
   await cacheInvalidate(LP_OVERVIEW_CACHE_KEY);
}

/**
 * Aggregates protocol-owned liquidity across all keys: total LP XLM
 * contributed, the number of keys holding LP, and the number of
 * allocation events that make up the total.
 */
export async function getProtocolLpOverview(): Promise<LpOverview> {
   const cached = await cacheGetJson<LpOverview>(LP_OVERVIEW_CACHE_KEY);
   if (cached) {
      return cached;
   }

   const [aggregate, distinctKeys] = await Promise.all([
      prisma.lpAllocation.aggregate({
         _sum: { amountXlm: true },
         _count: { _all: true },
      }),
      prisma.lpAllocation.findMany({
         distinct: ['creatorId'],
         select: { creatorId: true },
      }),
   ]);

   const overview: LpOverview = {
      totalProtocolLpXlm: aggregate._sum.amountXlm?.toString() ?? '0',
      keyCount: distinctKeys.length,
      allocationCount: aggregate._count._all,
   };

   await cacheSetJson(
      LP_OVERVIEW_CACHE_KEY,
      overview,
      LP_OVERVIEW_CACHE_TTL_SECONDS
   );
   return overview;
}
