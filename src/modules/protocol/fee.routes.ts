import { Router } from 'express';
import { z } from 'zod';
import {
   sendError,
   sendSuccess,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import { ErrorCode } from '../../constants/error.constants';
import { requireJwtAuth } from '../../middlewares/jwt-auth.middleware';
import {
   adminGuard,
   AdminRequest,
} from '../../middlewares/admin-guard.middleware';
import {
   getCurrentFeeTier,
   updateFeeTierConfig,
   loadFeeTierConfig,
} from './fee-tier.service';
import { logger } from '../../utils/logger.utils';

const updateFeeTierBodySchema = z.object({
   tiers: z
      .array(
         z.object({
            volumeThreshold: z
               .number()
               .nonnegative('volumeThreshold must be non-negative'),
            feeBps: z
               .number()
               .int()
               .min(1, 'feeBps must be at least 1')
               .max(10000, 'feeBps must not exceed 10000'),
            label: z.string().optional(),
         })
      )
      .min(1, 'At least one tier is required'),
});

const router = Router();

/**
 * GET /api/v1/fees/current
 * Get current protocol fee tier based on rolling 24h trading volume.
 * Returns active fee percentage, tier label, current volume, and volume until next tier.
 * Cached with 60s TTL.
 * No auth required.
 */
router.get('/current', async (_req, res, next) => {
   try {
      const currentFee = await getCurrentFeeTier();
      sendSuccess(res, currentFee);
   } catch (error) {
      logger.error({ error }, 'Failed to get current fee tier');
      next(error);
   }
});

/**
 * GET /api/v1/fees/tiers
 * Get all configured fee tiers.
 * No auth required.
 */
router.get('/tiers', async (_req, res, next) => {
   try {
      const tiers = await loadFeeTierConfig();
      sendSuccess(res, { tiers });
   } catch (error) {
      logger.error({ error }, 'Failed to get fee tiers');
      next(error);
   }
});

/**
 * PATCH /api/v1/fees/tiers
 * Admin endpoint to update fee tier configuration.
 * Restricted to admin role.
 * Invalidates cache and records audit trail.
 */
router.patch('/tiers', requireJwtAuth, adminGuard, async (req, res, next) => {
   const parsed = updateFeeTierBodySchema.safeParse(req.body);
   if (!parsed.success) {
      sendValidationError(
         res,
         'Invalid fee tier update request',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }

   try {
      const { tiers } = parsed.data;
      const adminId = (req as AdminRequest).adminId || '';
      const updatedTiers = await updateFeeTierConfig(tiers, adminId);
      sendSuccess(
         res,
         { tiers: updatedTiers },
         200,
         'Fee tiers updated successfully'
      );
   } catch (error) {
      if (error instanceof Error) {
         sendError(res, 400, ErrorCode.BAD_REQUEST, error.message);
         return;
      }
      logger.error({ error }, 'Fee tier update failed');
      next(error);
   }
});

export default router;
