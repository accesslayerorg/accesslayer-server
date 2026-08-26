// src/modules/analytics/analytics.cache.ts
// Redis caching for the key analytics time series (10-minute TTL).

import { getRedisClient } from '../../utils/redis.utils';
import { logger } from '../../utils/logger.utils';
import type { KeyAnalytics } from './analytics.service';

const ANALYTICS_TTL_SECONDS = 10 * 60; // 10 minutes

export function analyticsCacheKey(keyId: string): string {
   return `analytics:${keyId}`;
}

export async function getCachedAnalytics(
   keyId: string
): Promise<KeyAnalytics | null> {
   try {
      const redis = await getRedisClient();
      const cached = await redis.get(analyticsCacheKey(keyId));
      if (!cached) return null;
      return JSON.parse(cached) as KeyAnalytics;
   } catch (err) {
      logger.error(
         { type: 'analytics_cache_read_error', message: (err as Error).message },
         'Failed to read analytics cache'
      );
      return null;
   }
}

export async function setCachedAnalytics(
   keyId: string,
   analytics: KeyAnalytics
): Promise<void> {
   try {
      const redis = await getRedisClient();
      await redis.set(analyticsCacheKey(keyId), JSON.stringify(analytics), {
         EX: ANALYTICS_TTL_SECONDS,
      });
   } catch (err) {
      logger.error(
         { type: 'analytics_cache_write_error', message: (err as Error).message },
         'Failed to write analytics cache'
      );
   }
}

/**
 * Drops any cached analytics for a key. Called whenever a trade for the key is
 * recorded so the dashboard always reflects fresh data after the TTL would
 * otherwise serve stale numbers.
 */
export async function invalidateAnalyticsCache(keyId: string): Promise<void> {
   try {
      const redis = await getRedisClient();
      await redis.del(analyticsCacheKey(keyId));
   } catch (err) {
      logger.error(
         { type: 'analytics_cache_invalidate_error', message: (err as Error).message },
         'Failed to invalidate analytics cache'
      );
   }
}
