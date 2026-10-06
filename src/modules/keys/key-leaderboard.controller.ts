// src/modules/keys/key-leaderboard.controller.ts
import { AsyncController } from '../../types/auth.types';
import { getKeyLeaderboard } from './key-leaderboard.service';
import {
   sendSuccess,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import { attachTimestampHeader } from '../../utils/timestamp-headers.utils';
import { z } from 'zod';
import { safeIntParam } from '../../utils/query.utils';
import {
   DEFAULT_PAGE_SIZE,
   MAX_PAGE_SIZE,
} from '../../constants/pagination.constants';

const leaderboardQuerySchema = z.object({
   sort_by: z
      .enum(['holder_count', 'volume_24h', 'volume_7d', 'price_change'] as const)
      .optional()
      .default('holder_count'),
   limit: safeIntParam({
      defaultValue: DEFAULT_PAGE_SIZE,
      min: 1,
      max: MAX_PAGE_SIZE,
      label: 'Limit',
   }),
});

export const httpGetKeyLeaderboard: AsyncController = async (
   req,
   res,
   next
) => {
   try {
      const parsed = leaderboardQuerySchema.safeParse(req.query);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid query parameters',
            zodIssuesToDetails(parsed.error.issues)
         );
         return;
      }

      const { sort_by, limit } = parsed.data;
      const items = await getKeyLeaderboard(sort_by, limit);

      attachTimestampHeader(res);
      sendSuccess(res, { items });
   } catch (error) {
      next(error);
   }
};
