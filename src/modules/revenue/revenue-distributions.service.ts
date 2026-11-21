import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';

export const REVENUE_DISTRIBUTIONS_CACHE_TTL_SECONDS = 60;
const REVENUE_DISTRIBUTIONS_CACHE_PREFIX = 'key:revenue-distributions';

export function revenueDistributionCachePattern(keyId: string): string {
   return `${REVENUE_DISTRIBUTIONS_CACHE_PREFIX}:${keyId}:*`;
}

export interface RevenueDistributionEntry {
   distributionId: string;
   distributedAt: string;
   amount: number;
   holderCount: number;
}

export interface RevenueDistributionPage {
   entries: RevenueDistributionEntry[];
   pagination: {
      limit: number;
      hasMore: boolean;
      nextCursor?: string;
   };
}

export async function getRevenueDistributions(input: {
   keyId: string;
   limit: number;
   cursor?: string;
}): Promise<RevenueDistributionPage> {
   const cacheKey = `${REVENUE_DISTRIBUTIONS_CACHE_PREFIX}:${input.keyId}:list:${input.limit}:${input.cursor ?? ''}`;
   const cached = await cacheGetJson<RevenueDistributionPage>(cacheKey);
   if (cached) {
      return cached;
   }

   const distributions = await prisma.revenueDistribution.findMany({
      where: { keyId: input.keyId },
      orderBy: [{ distributedAt: 'desc' }, { id: 'desc' }],
      take: input.limit + 1,
      skip: input.cursor ? 1 : 0,
      cursor: input.cursor ? { id: input.cursor } : undefined,
   });
   const hasMore = distributions.length > input.limit;
   const page = distributions.slice(0, input.limit);
   const result: RevenueDistributionPage = {
      entries: page.map(distribution => ({
         distributionId: distribution.chainDistributionId ?? distribution.id,
         distributedAt: distribution.distributedAt.toISOString(),
         amount: Number(distribution.amount),
         holderCount: distribution.holderCount,
      })),
      pagination: {
         limit: input.limit,
         hasMore,
         nextCursor:
            hasMore && page.length > 0 ? page[page.length - 1].id : undefined,
      },
   };

   await cacheSetJson(
      cacheKey,
      result,
      REVENUE_DISTRIBUTIONS_CACHE_TTL_SECONDS
   );
   return result;
}

export interface WalletRevenueDistributionEntry extends RevenueDistributionEntry {
   claimableAmount: number;
   claimedAmount: number;
}

export async function getWalletRevenueDistributions(input: {
   keyId: string;
   wallet: string;
}): Promise<WalletRevenueDistributionEntry[]> {
   const cacheKey = `${REVENUE_DISTRIBUTIONS_CACHE_PREFIX}:${input.keyId}:wallet:${input.wallet}`;
   const cached =
      await cacheGetJson<WalletRevenueDistributionEntry[]>(cacheKey);
   if (cached) {
      return cached;
   }

   const distributions = await prisma.revenueDistribution.findMany({
      where: { keyId: input.keyId },
      orderBy: [{ distributedAt: 'desc' }, { id: 'desc' }],
      include: {
         shares: {
            where: { wallet: input.wallet },
            include: {
               claims: {
                  where: { wallet: input.wallet },
                  select: { amount: true },
               },
            },
         },
      },
   });

   const result = distributions.map(distribution => {
      const share = distribution.shares[0];
      const claimableAmount = share ? Number(share.amount) : 0;
      const claimedAmount =
         share?.claims.reduce(
            (total, claim) => total + Number(claim.amount),
            0
         ) ?? 0;
      return {
         distributionId: distribution.chainDistributionId ?? distribution.id,
         distributedAt: distribution.distributedAt.toISOString(),
         amount: Number(distribution.amount),
         holderCount: distribution.holderCount,
         claimableAmount: Math.max(0, claimableAmount - claimedAmount),
         claimedAmount,
      };
   });

   await cacheSetJson(
      cacheKey,
      result,
      REVENUE_DISTRIBUTIONS_CACHE_TTL_SECONDS
   );
   return result;
}
