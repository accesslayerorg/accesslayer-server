import { AsyncController } from '../../types/auth.types';
import { ActivityFeedQuerySchema } from './activity-feed.schemas';
import { getActivityFeed } from './activity-feed.service';
import {
   sendSuccess,
   sendValidationError,
} from '../../utils/api-response.utils';

export const httpGetPlatformActivityFeed: AsyncController = async (
   req,
   res,
   next
) => {
   try {
      const parsed = ActivityFeedQuerySchema.safeParse(req.query);
      if (!parsed.success) {
         return sendValidationError(
            res,
            'Invalid query parameters',
            parsed.error.issues.map(issue => ({
               field: issue.path.join('.'),
               message: issue.message,
            }))
         );
      }

      const result = await getActivityFeed(parsed.data.cursor);
      sendSuccess(res, result);
   } catch (error) {
      next(error);
   }
};
