import { Router } from 'express';
import { z } from 'zod';
import {
   sendSuccess,
   sendNotFound,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import {
   getCreatorReputation,
   getCreatorReputationHistory,
   CreatorNotFoundError,
} from './creator-reputation.service';
import { logger } from '../../utils/logger.utils';

const reputationHistoryQuerySchema = z.object({
   limit: z
      .string()
      .transform(v => {
         const num = parseInt(v, 10);
         if (isNaN(num) || num < 1 || num > 100) {
            throw new Error('Limit must be between 1 and 100');
         }
         return num;
      })
      .optional(),
   cursor: z.string().optional(),
});

const router = Router();

/**
 * GET /api/v1/creators/:wallet/reputation
 * Get creator reputation score, tier, and breakdown of contributing factors.
 * Returns: score, tier, and breakdown (key launches, milestones, governance votes, deprecations).
 * Cached with 60s TTL per creator.
 * No auth required.
 */
router.get('/:wallet/reputation', async (req, res, next) => {
   try {
      const wallet = req.params.wallet;
      const reputation = await getCreatorReputation(wallet);
      sendSuccess(res, reputation);
   } catch (error) {
      if (error instanceof CreatorNotFoundError) {
         sendNotFound(res, 'Creator');
         return;
      }
      logger.error(
         { error, wallet: req.params.wallet },
         'Failed to get creator reputation'
      );
      next(error);
   }
});

/**
 * GET /api/v1/creators/:wallet/reputation/history?limit=&cursor=
 * Get paginated history of creator reputation score over time.
 * Returns score progression in chronological order.
 * No auth required.
 */
router.get('/:wallet/reputation/history', async (req, res, next) => {
   const parsed = reputationHistoryQuerySchema.safeParse(req.query);
   if (!parsed.success) {
      sendValidationError(
         res,
         'Invalid reputation history query',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }

   try {
      const wallet = req.params.wallet;
      const { limit, cursor } = parsed.data;
      const history = await getCreatorReputationHistory(wallet, limit, cursor);
      sendSuccess(res, history);
   } catch (error) {
      if (error instanceof CreatorNotFoundError) {
         sendNotFound(res, 'Creator');
         return;
      }
      logger.error(
         { error, wallet: req.params.wallet },
         'Failed to get creator reputation history'
      );
      next(error);
   }
});

export default router;
