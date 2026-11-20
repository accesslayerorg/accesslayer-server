// src/constants/volume-discount.constants.ts
// Configuration, cache TTLs and defaults for volume discount tiers (#1030).

export interface VolumeDiscountTierDto {
   tier: number;
   name?: string;
   volumeThreshold: string;
   discountBps: number;
}

/** 5-minute TTL per wallet cache as per requirements (#1030). */
export const VOLUME_DISCOUNT_WALLET_CACHE_TTL_SECONDS = 300;

/** 5-minute TTL for global tiers cache. */
export const VOLUME_DISCOUNT_TIERS_CACHE_TTL_SECONDS = 300;

export const traderDiscountRedisKey = (wallet: string): string =>
   `traders:discount:${wallet}`;

export const VOLUME_DISCOUNT_TIERS_REDIS_KEY = 'volume-discount:tiers';

/**
 * Default fee discount tiers based on 30-day rolling volume.
 * Tiers are evaluated in descending order of volume threshold.
 * 
 * - Tier 0: 0 stroops threshold -> 0 bps discount (Base rate)
 * - Tier 1: 100,000 XLM (1e12 stroops) -> 100 bps discount (1.0%)
 * - Tier 2: 500,000 XLM (5e12 stroops) -> 200 bps discount (2.0%)
 */
export const DEFAULT_DISCOUNT_TIERS: VolumeDiscountTierDto[] = [
   {
      tier: 0,
      name: 'TIER_0',
      volumeThreshold: '0',
      discountBps: 0,
   },
   {
      tier: 1,
      name: 'TIER_1',
      volumeThreshold: '1000000000000',
      discountBps: 100,
   },
   {
      tier: 2,
      name: 'TIER_2',
      volumeThreshold: '5000000000000',
      discountBps: 200,
   },
];
