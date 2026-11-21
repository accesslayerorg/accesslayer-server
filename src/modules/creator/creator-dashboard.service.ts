// src/modules/creator/creator-dashboard.service.ts
import { prisma } from '../../utils/prisma.utils';
import {
   cacheGetJson,
   cacheSetJson,
   cacheInvalidate,
} from '../../utils/redis.utils';
import { computePriceChange } from '../../utils/price-change.utils';
import { compute24hPriceChange } from '../../utils/price.utils';

export class KeyNotFoundError extends Error {
   constructor(keyId: string) {
      super(`Key not found: ${keyId}`);
      this.name = 'KeyNotFoundError';
   }
}

export interface CreatorDashboardSummary {
   currentPrice: string;
   circulatingSupply: string;
   holderCount: number;
   totalRoyaltyEarned: string;
   totalDividendsDistributed: string;
   tradeCount: number;
   priceChange24h: number;
}

export const CREATOR_DASHBOARD_CACHE_TTL_SECONDS = 120; // 2 minutes

export function getCreatorDashboardCacheKey(keyId: string): string {
   return `creator:dashboard:${keyId}`;
}

export async function invalidateCreatorDashboardCache(
   keyId: string
): Promise<void> {
   const cacheKey = getCreatorDashboardCacheKey(keyId);
   await cacheInvalidate(cacheKey, `creator-dashboard:${keyId}`);
}

export async function getCreatorDashboard(
   keyId: string
): Promise<CreatorDashboardSummary> {
   const cacheKey = getCreatorDashboardCacheKey(keyId);

   // Check Redis cache first
   const cached = await cacheGetJson<CreatorDashboardSummary>(cacheKey);
   if (cached) {
      return cached;
   }

   // Fetch creator profile with price snapshot
   const creator = await prisma.creatorProfile.findFirst({
      where: { OR: [{ id: keyId }, { handle: keyId }] },
      include: { priceSnapshot: true },
   });

   if (!creator) {
      throw new KeyNotFoundError(keyId);
   }

   const resolvedKeyId = creator.id;

   // 1. Current Price
   const currentPrice = creator.priceSnapshot
      ? creator.priceSnapshot.currentPrice.toString()
      : '0';

   // 2. Circulating Supply
   const circulatingSupply = creator.circulatingSupply
      ? creator.circulatingSupply.toString()
      : '0';

   // 3. Holder Count (wallets with balance > 0)
   const holderCount = await prisma.keyOwnership.count({
      where: {
         creatorId: resolvedKeyId,
         balance: { gt: 0 },
      },
   });

   // 4. Trades & Royalty Earned
   const trades = await prisma.trade.findMany({
      where: { creatorId: resolvedKeyId },
      select: { price: true, quantity: true },
   });

   const tradeCount = trades.length;
   let totalRoyalty = 0n;
   const maxBps = BigInt(
      Math.max(creator.creatorRoyaltyBuyBps, creator.creatorRoyaltySellBps)
   );

   for (const trade of trades) {
      const p = BigInt(trade.price);
      const q = BigInt(trade.quantity);
      totalRoyalty += (p * q * maxBps) / 10000n;
   }
   const totalRoyaltyEarned = totalRoyalty.toString();

   // 5. Total Dividends Distributed
   const dividendAgg = await prisma.dividendDistribution.aggregate({
      where: { creatorId: resolvedKeyId },
      _sum: { totalAmountXlm: true },
   });

   const totalDividendsDistributed =
      dividendAgg._sum.totalAmountXlm !== null &&
      dividendAgg._sum.totalAmountXlm !== undefined
         ? Number(dividendAgg._sum.totalAmountXlm).toString()
         : '0';

   // 6. Price Change 24h
   const ONE_DAY_MS = 86_400_000;
   let priceChange24h = 0;
   try {
      const computedChange = await computePriceChange(
         resolvedKeyId,
         ONE_DAY_MS,
         prisma
      );
      if (computedChange !== null) {
         priceChange24h = computedChange;
      } else if (creator.priceSnapshot) {
         priceChange24h = compute24hPriceChange(
            creator.priceSnapshot.currentPrice,
            creator.priceSnapshot.price24hAgo
         );
      }
   } catch {
      if (creator.priceSnapshot) {
         priceChange24h = compute24hPriceChange(
            creator.priceSnapshot.currentPrice,
            creator.priceSnapshot.price24hAgo
         );
      }
   }

   const dashboard: CreatorDashboardSummary = {
      currentPrice,
      circulatingSupply,
      holderCount,
      totalRoyaltyEarned,
      totalDividendsDistributed,
      tradeCount,
      priceChange24h,
   };

   // Write to Redis with 2m TTL
   await cacheSetJson(cacheKey, dashboard, CREATOR_DASHBOARD_CACHE_TTL_SECONDS);

   return dashboard;
}

export async function getKeyMilestones(keyId: string) {
   const creator = await prisma.creatorProfile.findFirst({
      where: {
         OR: [{ id: keyId }, { handle: keyId }],
      },
      select: {
         id: true,
         createdAt: true,
      },
   });

   if (!creator) {
      throw new KeyNotFoundError(keyId);
   }

   const resolvedKeyId = creator.id;

   const [tradeCount, holderCount, dividendAgg] = await Promise.all([
      prisma.trade.count({
         where: { creatorId: resolvedKeyId },
      }),
      prisma.keyOwnership.count({
         where: {
            creatorId: resolvedKeyId,
            balance: { gt: 0 },
         },
      }),
      prisma.dividendDistribution.aggregate({
         where: { creatorId: resolvedKeyId },
         _sum: { totalAmountXlm: true },
      }),
   ]);

   return {
      createdAt: creator.createdAt,
      tradeCount,
      holderCount,
      totalDividendsDistributed:
         dividendAgg._sum.totalAmountXlm?.toString() ?? '0',
   };
}
