// src/modules/referrals/referral-tier.constants.ts
// Referral tier definitions, threshold maths and Redis cache keys (#1034).
//
// A referrer's tier is a function of the cumulative volume of referrals they
// have driven. Each tier carries a reward rate (in basis points) that is
// applied to referred volume. The on-chain `ReferralTierUpgraded` event is
// authoritative for a wallet's current tier; these definitions supply the
// threshold + reward-rate metadata the API reports alongside it.

/** Redis TTL for a wallet's cached tier snapshot (5 minutes). */
export const REFERRAL_TIER_CACHE_TTL_SECONDS = 300;

export interface ReferralTierDefinition {
   /** Tier number (1-based). */
   tier: number;
   /** Minimum cumulative referred volume (XLM) required to reach this tier. */
   minVolume: number;
   /** Reward rate applied to referred volume at this tier, in basis points. */
   rewardRateBps: number;
}

/**
 * Tier ladder, ordered by ascending threshold. Tier 1 is the entry tier
 * (minVolume 0) so every wallet has a tier.
 */
export const REFERRAL_TIER_DEFINITIONS: readonly ReferralTierDefinition[] = [
   { tier: 1, minVolume: 0, rewardRateBps: 500 },
   { tier: 2, minVolume: 1_000, rewardRateBps: 750 },
   { tier: 3, minVolume: 10_000, rewardRateBps: 1_000 },
];

export const MIN_REFERRAL_TIER = 1;
export const MAX_REFERRAL_TIER = REFERRAL_TIER_DEFINITIONS.length;

/** Definition for a tier, falling back to the entry tier for unknown values. */
export function getReferralTierDefinition(
   tier: number
): ReferralTierDefinition {
   return (
      REFERRAL_TIER_DEFINITIONS.find(definition => definition.tier === tier) ??
      REFERRAL_TIER_DEFINITIONS[0]
   );
}

/** The tier immediately above `tier`, or `null` when already at the top. */
export function getNextReferralTier(
   tier: number
): ReferralTierDefinition | null {
   return REFERRAL_TIER_DEFINITIONS.find(d => d.tier === tier + 1) ?? null;
}

/** Highest tier whose threshold has been met by `volume`. */
export function getReferralTierForVolume(volume: number): number {
   let tier = MIN_REFERRAL_TIER;
   for (const definition of REFERRAL_TIER_DEFINITIONS) {
      if (volume >= definition.minVolume) {
         tier = definition.tier;
      }
   }
   return tier;
}

/** Whether `tier` is a configured referral tier. */
export function isValidReferralTier(tier: number): boolean {
   return REFERRAL_TIER_DEFINITIONS.some(definition => definition.tier === tier);
}

const REFERRAL_TIER_CACHE_PREFIX = 'referrals:tier';

/** Deterministic Redis cache key for a wallet's tier snapshot. */
export function buildReferralTierCacheKey(wallet: string): string {
   return `${REFERRAL_TIER_CACHE_PREFIX}:${wallet.toLowerCase()}`;
}
