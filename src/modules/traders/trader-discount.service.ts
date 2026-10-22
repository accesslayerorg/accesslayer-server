// src/modules/traders/trader-discount.service.ts
// Service for volume discount tiers lookup and 30-day rolling volume computation (#1030).

import { prisma } from '../../utils/prisma.utils';
import {
   cacheGetJson,
   cacheSetJson,
   cacheInvalidate,
} from '../../utils/redis.utils';
import { computeWallet30dVolume } from '../../utils/trading-volume.utils';
import {
   DEFAULT_DISCOUNT_TIERS,
   VolumeDiscountTierDto,
   VOLUME_DISCOUNT_TIERS_CACHE_TTL_SECONDS,
   VOLUME_DISCOUNT_TIERS_REDIS_KEY,
   VOLUME_DISCOUNT_WALLET_CACHE_TTL_SECONDS,
   traderDiscountRedisKey,
} from '../../constants/volume-discount.constants';
import { logger } from '../../utils/logger.utils';

export interface TraderDiscountResponse {
   wallet: string;
   tier: number;
   tierLabel: string;
   discountBps: number;
   volume30d: string;
   volume30dStroops: string;
}

/**
 * Loads all configured volume discount tiers.
 * Results are cached in Redis with a 5-minute TTL.
 * Tiers are returned sorted descending by volumeThreshold.
 */
export async function getVolumeDiscountTiers(): Promise<VolumeDiscountTierDto[]> {
   try {
      const cached = await cacheGetJson<VolumeDiscountTierDto[]>(
         VOLUME_DISCOUNT_TIERS_REDIS_KEY
      );
      if (cached && Array.isArray(cached) && cached.length > 0) {
         return cached;
      }

      let tiers: VolumeDiscountTierDto[] = [];
      if (prisma.volumeDiscountTier) {
         const dbTiers = await prisma.volumeDiscountTier.findMany({
            orderBy: { volumeThreshold: 'desc' },
         });

         if (dbTiers.length > 0) {
            tiers = dbTiers.map(t => ({
               tier: t.tier,
               name: t.name ?? `TIER_${t.tier}`,
               volumeThreshold: t.volumeThreshold.toString(),
               discountBps: t.discountBps,
            }));
         }
      }

      if (tiers.length === 0) {
         tiers = [...DEFAULT_DISCOUNT_TIERS].sort(
            (a, b) => Number(BigInt(b.volumeThreshold) - BigInt(a.volumeThreshold))
         );
      }

      await cacheSetJson(
         VOLUME_DISCOUNT_TIERS_REDIS_KEY,
         tiers,
         VOLUME_DISCOUNT_TIERS_CACHE_TTL_SECONDS
      );

      return tiers;
   } catch (error) {
      logger.warn({ error }, 'Failed to load volume discount tiers, falling back to defaults');
      return [...DEFAULT_DISCOUNT_TIERS].sort(
         (a, b) => Number(BigInt(b.volumeThreshold) - BigInt(a.volumeThreshold))
      );
   }
}

/**
 * Invalidate cached tiers in Redis and all trader discount caches.
 */
export async function invalidateVolumeDiscountTiersCache(): Promise<void> {
   await cacheInvalidate(
      VOLUME_DISCOUNT_TIERS_REDIS_KEY,
      'traders:discount:*'
   );
}

/**
 * Invalidate the 5-minute discount cache for a specific wallet or all wallets.
 */
export async function invalidateTraderDiscountCache(wallet?: string): Promise<void> {
   if (wallet) {
      await cacheInvalidate(traderDiscountRedisKey(wallet));
   } else {
      await cacheInvalidate('traders:discount:*');
   }
}

/**
 * Computes and returns the volume discount tier and discount bps for any wallet.
 * Uses rolling 30-day trading volume window.
 * Cached in Redis with a 5-minute TTL per wallet (#1030).
 */
export async function getTraderDiscount(wallet: string): Promise<TraderDiscountResponse> {
   const cacheKey = traderDiscountRedisKey(wallet);
   const cached = await cacheGetJson<TraderDiscountResponse>(cacheKey);

   if (cached !== null) {
      return cached;
   }

   // 1. Calculate 30-day rolling volume for wallet
   const volume30d = await computeWallet30dVolume(wallet);

   // 2. Load configured discount tiers (sorted descending by threshold)
   const tiers = await getVolumeDiscountTiers();

   // 3. Find highest threshold tier the wallet qualifies for
   const matchedTier =
      tiers.find(t => BigInt(t.volumeThreshold) <= volume30d) ??
      tiers[tiers.length - 1] ??
      DEFAULT_DISCOUNT_TIERS[0];

   const result: TraderDiscountResponse = {
      wallet,
      tier: matchedTier.tier,
      tierLabel: matchedTier.name ?? `TIER_${matchedTier.tier}`,
      discountBps: matchedTier.discountBps,
      volume30d: volume30d.toString(),
      volume30dStroops: volume30d.toString(),
   };

   // 4. Cache with 5-minute TTL (300 seconds)
   await cacheSetJson(cacheKey, result, VOLUME_DISCOUNT_WALLET_CACHE_TTL_SECONDS);

   return result;
}
