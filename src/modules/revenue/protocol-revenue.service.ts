// src/modules/revenue/protocol-revenue.service.ts
// Past protocol revenue distributions and per-wallet earnings (#875).

import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';

const PROTOCOL_REVENUE_CACHE_TTL_SECONDS = 120;

export function protocolRevenueCachePattern(wallet: string): string {
   return `staker:protocol-revenue:${wallet}:*`;
}

export interface ProtocolRevenueEntry {
   distributionId: string;
   totalDistributed: number;
   stakerCount: number;
   amountReceived: number;
   snapshotId: string;
   distributedAt: string;
}

export interface ProtocolRevenuePage {
   entries: ProtocolRevenueEntry[];
   pagination: {
      limit: number;
      hasMore: boolean;
      nextCursor?: string;
   };
}

/**
 * Distributions the wallet received a share of, newest first, with
 * cursor-based pagination. Cached per (wallet, limit, cursor) for 2 minutes.
 */
export async function getProtocolRevenueForWallet(input: {
   wallet: string;
   limit: number;
   cursor?: string;
}): Promise<ProtocolRevenuePage> {
   const { wallet, limit, cursor } = input;
   const cacheKey = `staker:protocol-revenue:${wallet}:${limit}:${cursor ?? ''}`;
   const cached = await cacheGetJson<ProtocolRevenuePage>(cacheKey);
   if (cached) {
      return cached;
   }

   const shares = await prisma.protocolRevenueShare.findMany({
      where: { wallet },
      include: { distribution: true },
      orderBy: [{ distribution: { distributedAt: 'desc' } }, { id: 'desc' }],
      take: limit + 1,
      skip: cursor ? 1 : 0,
      cursor: cursor ? { id: cursor } : undefined,
   });

   const hasMore = shares.length > limit;
   const page = shares.slice(0, limit);
   const result: ProtocolRevenuePage = {
      entries: page.map(share => ({
         distributionId: share.distribution.distributionId,
         totalDistributed: Number(share.distribution.totalDistributed),
         stakerCount: share.distribution.stakerCount,
         amountReceived: Number(share.amount),
         snapshotId: share.distribution.snapshotId,
         distributedAt: share.distribution.distributedAt.toISOString(),
      })),
      pagination: {
         limit,
         hasMore,
         nextCursor:
            hasMore && page.length > 0 ? page[page.length - 1].id : undefined,
      },
   };

   await cacheSetJson(cacheKey, result, PROTOCOL_REVENUE_CACHE_TTL_SECONDS);
   return result;
}
