// src/modules/referrals/referral-earnings.constants.ts
// Tunables and Redis cache keys for the referral earnings endpoints (#1057).

/** Redis TTL for the cached referral earnings summary (2 minutes). */
export const REFERRAL_EARNINGS_SUMMARY_CACHE_TTL_SECONDS = 120;

const REFERRAL_EARNINGS_CACHE_PREFIX = 'referrals:earnings';

/** Deterministic Redis cache key for a wallet's referral earnings summary. */
export function buildReferralEarningsSummaryCacheKey(wallet: string): string {
   return `${REFERRAL_EARNINGS_CACHE_PREFIX}:summary:${wallet.toLowerCase()}`;
}

/**
 * Glob pattern matching every cached artifact for a wallet. Passed to
 * `cacheInvalidate` when a new reward lands so pagination/summary reads do not
 * serve stale earnings.
 */
export function referralEarningsCachePattern(wallet: string): string {
   return `${REFERRAL_EARNINGS_CACHE_PREFIX}:${wallet.toLowerCase()}:*`;
}
