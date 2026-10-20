// src/modules/analytics/analytics.routes.ts
import { Router } from 'express';
import { sendSuccess, sendValidationError } from '../../utils/api-response.utils';
import { logger } from '../../utils/logger.utils';
import {
   getKeyDiscoveryLeaderboard,
   LeaderboardMetric,
} from './key-leaderboard.service';

const router = Router();

/**
 * GET /api/v1/analytics/keys/leaderboard?metric=volume|holders|reputation&limit=N
 * Returns platform-wide key discovery leaderboard ranked by metric.
 * Cached with 5-minute (300s) TTL.
 * No auth required.
 */
router.get('/keys/leaderboard', async (req, res, next) => {
   try {
      const metricQuery = (req.query.metric as string) || 'volume';
      if (!['volume', 'holders', 'reputation'].includes(metricQuery)) {
         sendValidationError(res, 'Invalid metric parameter', [
            { field: 'metric', message: 'metric must be one of: volume, holders, reputation' },
         ]);
         return;
      }

      const limitQuery = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
      const limit = isNaN(limitQuery) ? 50 : limitQuery;

      const leaderboard = await getKeyDiscoveryLeaderboard(
         metricQuery as LeaderboardMetric,
         limit
      );

      sendSuccess(res, leaderboard);
   } catch (error) {
      logger.error({ error }, 'Discovery leaderboard fetch failed');
      next(error);
   }
});

export default router;
