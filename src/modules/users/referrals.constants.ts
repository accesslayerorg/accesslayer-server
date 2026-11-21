// src/modules/users/referrals.constants.ts
// Tunables and cache keys for the referral earnings endpoint.

/** Redis TTL for the cached referral summary (2 minutes). */
export const REFERRAL_SUMMARY_CACHE_TTL_SECONDS = 120;

const REFERRAL_SUMMARY_CACHE_PREFIX = 'users:referrals:summary';

/** Deterministic Redis cache key for a wallet's referral summary. */
export function buildReferralSummaryCacheKey(wallet: string): string {
   return `${REFERRAL_SUMMARY_CACHE_PREFIX}:${wallet.toLowerCase()}`;
}
