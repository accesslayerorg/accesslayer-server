import { Router, Request, Response, NextFunction } from 'express';
import {
   sendSuccess,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import { activityHeatmapQuerySchema } from './activity-heatmap.schemas';
import { getActivityHeatmap } from './activity-heatmap.service';

export const activityHeatmapRouter = Router();

/**
 * GET /v1/keys/:keyId/activity-heatmap?range=&tz=
 * Returns a 7x24 weekday/hour matrix shifted to the requested IANA timezone,
 * plus busiest slot and total trades, cached for 5 minutes.
 */
activityHeatmapRouter.get(
   '/:keyId/activity-heatmap',
   async (req: Request, res: Response, next: NextFunction) => {
      const keyId = String(req.params.keyId ?? '').trim();
      if (!keyId) {
         sendValidationError(res, 'keyId is required');
         return;
      }

      const query = activityHeatmapQuerySchema.safeParse(req.query);
      if (!query.success) {
         sendValidationError(
            res,
            'Invalid activity heatmap query parameters',
            zodIssuesToDetails(query.error.issues)
         );
         return;
      }

      try {
         const result = await getActivityHeatmap(
            keyId,
            query.data.range,
            query.data.tz
         );
         sendSuccess(res, result, 200);
      } catch (error) {
         next(error);
      }
   }
);

export default activityHeatmapRouter;
