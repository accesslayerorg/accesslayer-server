// src/modules/referrals/referrals.cache.ts
// Redis caching for the referral summary (2-minute TTL).

import { getRedisClient } from '../../utils/redis.utils';
import { logger } from '../../utils/logger.utils';
import type { ReferralSummary } from './referrals.service';

const REFERRAL_SUMMARY_TTL_SECONDS = 2 * 60; // 2 minutes

export function referralSummaryCacheKey(wallet: string): string {
   return `referrals:summary:${wallet}`;
}

export async function getCachedReferralSummary(
   wallet: string
): Promise<ReferralSummary | null> {
   try {
      const redis = await getRedisClient();
      const cached = await redis.get(referralSummaryCacheKey(wallet));
      if (!cached) return null;
      return JSON.parse(cached) as ReferralSummary;
   } catch (err) {
      logger.error(
         {
            type: 'referral_cache_read_error',
            message: (err as Error).message,
         },
         'Failed to read referral summary cache'
      );
      return null;
   }
}

export async function setCachedReferralSummary(
   wallet: string,
   summary: ReferralSummary
): Promise<void> {
   try {
      const redis = await getRedisClient();
      await redis.set(
         referralSummaryCacheKey(wallet),
         JSON.stringify(summary),
         { EX: REFERRAL_SUMMARY_TTL_SECONDS }
      );
   } catch (err) {
      logger.error(
         {
            type: 'referral_cache_write_error',
            message: (err as Error).message,
         },
         'Failed to write referral summary cache'
      );
   }
}

/**
 * Drops the cached summary for a wallet. Called whenever a new
 * `referral_fee_paid` event is recorded for that wallet.
 */
export async function invalidateReferralSummary(wallet: string): Promise<void> {
   try {
      const redis = await getRedisClient();
      await redis.del(referralSummaryCacheKey(wallet));
   } catch (err) {
      logger.error(
         {
            type: 'referral_cache_invalidate_error',
            message: (err as Error).message,
         },
         'Failed to invalidate referral summary cache'
      );
   }
}
