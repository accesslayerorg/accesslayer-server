import { z } from 'zod';
import { AsyncController } from '../../types/auth.types';
import {
   sendSuccess,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import { safeIntParam } from '../../utils/query.utils';
import {
   DEFAULT_PAGE_SIZE,
   MAX_PAGE_SIZE,
} from '../../constants/pagination.constants';
import {
   getKeyEventLeaderboard,
   getWalletKeyLeaderboard,
   KEY_LEADERBOARD_METRICS,
} from './key-event-leaderboard.service';

const leaderboardQuerySchema = z.object({
   metric: z.enum(KEY_LEADERBOARD_METRICS),
   limit: safeIntParam({
      defaultValue: DEFAULT_PAGE_SIZE,
      min: 1,
      max: MAX_PAGE_SIZE,
      label: 'Limit',
   }),
});

export const httpGetKeyEventLeaderboard: AsyncController = async (
   req,
   res,
   next
) => {
   const parsed = leaderboardQuerySchema.safeParse(req.query);
   if (!parsed.success) {
      sendValidationError(
         res,
         'Invalid query parameters',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }

   try {
      const { metric, limit } = parsed.data;
      const items = await getKeyEventLeaderboard(
         String(req.params.keyId),
         metric,
         limit
      );
      sendSuccess(res, { items });
   } catch (error) {
      next(error);
   }
};

export const httpGetWalletKeyEventLeaderboard: AsyncController = async (
   req,
   res,
   next
) => {
   try {
      const result = await getWalletKeyLeaderboard(
         String(req.params.keyId),
         String(req.params.wallet)
      );
      sendSuccess(res, result);
   } catch (error) {
      next(error);
   }
};
