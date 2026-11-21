// src/modules/creator/creator-analytics.controller.ts
// Handler + cache plumbing for GET /api/v1/creators/:keyId/analytics.
//
// The full 30-day series is cached in Redis under a per-key key with a
// 10-minute TTL. `invalidateCreatorAnalyticsCache` must be invoked by every
// trade ingestion path (buy, sell, indexer replay) so charts stay fresh
// without waiting out the TTL.

import { Response } from 'express';
import { ErrorCode, sendError, sendSuccess } from '../../utils/api-response.utils';
import {
   cacheGetJson,
   cacheSetJson,
   cacheInvalidate,
} from '../../utils/redis.utils';
import { logger } from '../../utils/logger.utils';
import { attachTimestampHeader } from '../../utils/timestamp-headers.utils';
import { AuthenticatedRequest } from '../../middlewares/jwt-auth.middleware';
import {
   buildCreatorAnalyticsCacheKey,
   ANALYTICS_CACHE_TTL_SECONDS,
} from './creator-analytics.constants';
import {
   CreatorAnalyticsResult,
   getCreatorAnalytics,
} from './creator-analytics.service';

export async function httpGetCreatorAnalytics(
   req: AuthenticatedRequest,
   res: Response
): Promise<void> {
   try {
      const keyId = Array.isArray(req.params.keyId)
         ? req.params.keyId[0]
         : req.params.keyId;

      const cacheKey = buildCreatorAnalyticsCacheKey(keyId);

      const cached =
         await cacheGetJson<CreatorAnalyticsResult>(cacheKey);
      if (cached) {
         attachTimestampHeader(res);
         sendSuccess(res, cached, 200, 'Creator analytics retrieved successfully');
         return;
      }

      const analytics = await getCreatorAnalytics(keyId);

      await cacheSetJson(
         cacheKey,
         analytics,
         ANALYTICS_CACHE_TTL_SECONDS
      );

      attachTimestampHeader(res);
      sendSuccess(res, analytics, 200, 'Creator analytics retrieved successfully');
   } catch (error) {
      logger.error(
         {
            type: 'creator_analytics_handler_error',
            handler: 'httpGetCreatorAnalytics',
            ...(req.requestId ? { requestId: req.requestId } : {}),
            error,
         },
         'Failed to retrieve creator analytics'
      );
      sendError(res, 500, ErrorCode.INTERNAL_ERROR, 'Failed to retrieve creator analytics');
   }
}

/**
 * Invalidate the cached analytics payload for a key. Call after every trade
 * (buy or sell) is recorded for the key so the next request recomputes from
 * source data.
 */
export async function invalidateCreatorAnalyticsCache(keyId: string): Promise<void> {
   await cacheInvalidate(buildCreatorAnalyticsCacheKey(keyId));
}
