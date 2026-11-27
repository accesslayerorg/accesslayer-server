// src/modules/analytics/analytics.routes.ts
import { Router } from 'express';
import { z } from 'zod';
import {
   sendSuccess,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import {
   getKeyAnalyticsLeaderboard,
   KEY_ANALYTICS_LEADERBOARD_DEFAULT_LIMIT,
   KEY_ANALYTICS_LEADERBOARD_MAX_LIMIT,
   KEY_ANALYTICS_LEADERBOARD_METRICS,
} from './key-leaderboard-analytics.service';

const router = Router();

const keyLeaderboardQuerySchema = z.object({
   metric: z.enum(KEY_ANALYTICS_LEADERBOARD_METRICS).optional().default('volume'),
   limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(KEY_ANALYTICS_LEADERBOARD_MAX_LIMIT)
      .optional()
      .default(KEY_ANALYTICS_LEADERBOARD_DEFAULT_LIMIT),
});

/**
 * GET /analytics/keys/leaderboard?metric=volume|holders|reputation&limit=N
 * Ranked keys with rank, key_id, key_name, creator, metric_value and 24h_change.
 * `limit` is capped at 100; larger values return 400.
 */
router.get('/keys/leaderboard', async (req, res, next) => {
   const parsed = keyLeaderboardQuerySchema.safeParse(req.query);
   if (!parsed.success) {
      sendValidationError(
         res,
         'Invalid query parameters',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }

   try {
      const items = await getKeyAnalyticsLeaderboard(
         parsed.data.metric,
         parsed.data.limit
      );
      sendSuccess(res, { metric: parsed.data.metric, items });
   } catch (error) {
      next(error);
   }
});

export default router;
