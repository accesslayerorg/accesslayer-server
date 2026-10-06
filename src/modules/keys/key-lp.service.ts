// src/modules/keys/key-lp.service.ts
// Liquidity-pool allocation tracking per key: cumulative LP contributed from
// bonding-curve buys (LPAllocationSent contract events) and the protocol's
// current LP balance for that key (#943). Stats are cached 60s; the LP
// allocation indexer invalidates the cache on every new event.
import { prisma } from '../../utils/prisma.utils';
import {
   cacheGetJson,
   cacheInvalidate,
   cacheSetJson,
} from '../../utils/redis.utils';
import { KeyNotFoundError } from './key-fees.service';

export const KEY_LP_STATS_CACHE_TTL_SECONDS = 60;

export interface KeyLpStats {
   keyId: string;
   /** Cumulative LP sent to the pool for this key, in XLM. Monotonic. */
   totalLpContributedXlm: string;
   /**
    * Current LP balance held for this key, in XLM. No "LP removed" contract
    * event exists in scope yet, so this currently equals the cumulative
    * amount contributed.
    */
   currentLpBalanceXlm: string;
   allocationCount: number;
}

export interface LpAllocationEntry {
   id: string;
   amountXlm: string;
   txHash: string;
   ledger: number;
   allocatedAt: string;
}

export interface LpAllocationPage {
   entries: LpAllocationEntry[];
   pagination: {
      limit: number;
      hasMore: boolean;
      nextCursor?: string;
   };
}

export function getKeyLpStatsCacheKey(keyId: string): string {
   return `key:lp-stats:${keyId}`;
}

export async function invalidateKeyLpStatsCache(keyId: string): Promise<void> {
   await cacheInvalidate(getKeyLpStatsCacheKey(keyId));
}

async function requireKey(keyId: string): Promise<void> {
   const creator = await prisma.creatorProfile.findUnique({
      where: { id: keyId },
      select: { id: true },
   });
   if (!creator) {
      throw new KeyNotFoundError(keyId);
   }
}

/**
 * Total LP contributed and current LP balance for a single key, cached
 * 60s. Throws KeyNotFoundError for unknown key IDs.
 */
export async function getKeyLpStats(keyId: string): Promise<KeyLpStats> {
   const cacheKey = getKeyLpStatsCacheKey(keyId);
   const cached = await cacheGetJson<KeyLpStats>(cacheKey);
   if (cached) {
      return cached;
   }

   await requireKey(keyId);

   const aggregate = await prisma.lpAllocation.aggregate({
      where: { creatorId: keyId },
      _sum: { amountXlm: true },
      _count: { _all: true },
   });

   const totalContributed = aggregate._sum.amountXlm?.toString() ?? '0';
   const stats: KeyLpStats = {
      keyId,
      totalLpContributedXlm: totalContributed,
      currentLpBalanceXlm: totalContributed,
      allocationCount: aggregate._count._all,
   };

   await cacheSetJson(cacheKey, stats, KEY_LP_STATS_CACHE_TTL_SECONDS);
   return stats;
}

/**
 * Paginated LP contribution history for a key, newest first, using
 * cursor-based pagination (cursor is the last row id of the previous page).
 */
export async function getKeyLpHistory(input: {
   keyId: string;
   limit: number;
   cursor?: string;
}): Promise<LpAllocationPage> {
   const { keyId, limit, cursor } = input;

   await requireKey(keyId);

   const allocations = await prisma.lpAllocation.findMany({
      where: { creatorId: keyId },
      orderBy: [{ allocatedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      skip: cursor ? 1 : 0,
      cursor: cursor ? { id: cursor } : undefined,
   });

   const hasMore = allocations.length > limit;
   const page = allocations.slice(0, limit);

   return {
      entries: page.map(allocation => ({
         id: allocation.id,
         amountXlm: allocation.amountXlm.toString(),
         txHash: allocation.txHash,
         ledger: allocation.ledger,
         allocatedAt: allocation.allocatedAt.toISOString(),
      })),
      pagination: {
         limit,
         hasMore,
         nextCursor:
            hasMore && page.length > 0 ? page[page.length - 1].id : undefined,
      },
   };
}
