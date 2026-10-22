// src/modules/staking/staking.routes.ts
// Staking reward multiplier tiers and position effective weight endpoints (#942).

import { Response, Router } from 'express';
import { z } from 'zod';
import {
   AuthenticatedRequest,
   requireJwtAuth,
} from '../../middlewares/jwt-auth.middleware';
import {
   sendConflict,
   sendForbidden,
   sendNotFound,
   sendSuccess,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import { logger } from '../../utils/logger.utils';
import {
   InvalidLockPeriodError,
   LockPeriodNotExpiredError,
   PositionAlreadyUnstakedError,
   stakeKeys,
   StakingKeyNotFoundError,
   unstakePosition,
} from './staking-position.service';
import {
   getMultiplierTiers,
   getPositionEffectiveWeight,
   getStakingPositionById,
   getStakingPositions,
   StakingPositionNotFoundError,
} from './staking.service';

const stakingRouter = Router();

const stakeBodySchema = z.object({
   keyId: z.string().min(1),
   // Positive decimal with up to 7 decimal places (matches Decimal(20,7)).
   amount: z
      .string()
      .regex(/^\d{1,13}(\.\d{1,7})?$/, 'Must be a positive decimal amount')
      .refine(value => Number(value) > 0, 'Must be greater than zero'),
   lockPeriod: z.string().min(1),
});

const unstakeBodySchema = z.object({
   positionId: z.string().min(1),
});

/**
 * POST /staking/stake
 * Creates a staking position for the authenticated wallet. `lockPeriod` is one
 * of the options configured via STAKING_LOCK_PERIOD_OPTIONS.
 */
stakingRouter.post(
   '/stake',
   requireJwtAuth,
   async (req: AuthenticatedRequest, res: Response, next) => {
      const parsed = stakeBodySchema.safeParse(req.body);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid request body',
            zodIssuesToDetails(parsed.error.issues)
         );
         return;
      }
      try {
         const position = await stakeKeys({
            ...parsed.data,
            wallet: req.user!.wallet,
         });
         sendSuccess(res, position, 201);
      } catch (error) {
         if (error instanceof InvalidLockPeriodError) {
            sendValidationError(res, 'Invalid lock period', [
               {
                  field: 'lockPeriod',
                  message: `Must be one of: ${error.validOptions.join(', ')}`,
               },
            ]);
            return;
         }
         if (error instanceof StakingKeyNotFoundError) {
            sendNotFound(res, 'Key');
            return;
         }
         logger.error({ error }, 'Failed to stake');
         next(error);
      }
   }
);

stakingRouter.all('/stake', (_req, res) => {
   res.set('Allow', 'POST').sendStatus(405);
});

/**
 * POST /staking/unstake
 * Unstakes a position owned by the authenticated wallet. Rejected with 403 while
 * the lock period has not expired.
 */
stakingRouter.post(
   '/unstake',
   requireJwtAuth,
   async (req: AuthenticatedRequest, res: Response, next) => {
      const parsed = unstakeBodySchema.safeParse(req.body);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid request body',
            zodIssuesToDetails(parsed.error.issues)
         );
         return;
      }
      try {
         const result = await unstakePosition({
            positionId: parsed.data.positionId,
            wallet: req.user!.wallet,
         });
         sendSuccess(res, result);
      } catch (error) {
         if (error instanceof StakingPositionNotFoundError) {
            sendNotFound(res, 'Staking position');
            return;
         }
         if (error instanceof PositionAlreadyUnstakedError) {
            sendConflict(res, 'Staking position already unstaked');
            return;
         }
         if (error instanceof LockPeriodNotExpiredError) {
            sendForbidden(res, 'Lock period has not expired', [
               {
                  field: 'positionId',
                  message: `Unlocks at ${error.unlocksAt.toISOString()}`,
               },
            ]);
            return;
         }
         logger.error({ error }, 'Failed to unstake');
         next(error);
      }
   }
);

stakingRouter.all('/unstake', (_req, res) => {
   res.set('Allow', 'POST').sendStatus(405);
});

/**
 * GET /staking/multiplier-tiers
 * Returns all reward multiplier tiers with their lock period requirements and multiplier values.
 * Result is cached in Redis with a 5-minute TTL.
 */
stakingRouter.get('/multiplier-tiers', async (_req, res, next) => {
   try {
      const tiers = await getMultiplierTiers();
      sendSuccess(res, tiers);
   } catch (error) {
      logger.error({ error }, 'Failed to fetch staking multiplier tiers');
      next(error);
   }
});

stakingRouter.all('/multiplier-tiers', (_req, res) => {
   res.set('Allow', 'GET').sendStatus(405);
});

/**
 * GET /staking/positions/:id/effective-weight
 * Returns the weighted stake calculation for a specific position.
 * Effective weight = Staked amount * Multiplier (determined by tier/lock period).
 */
stakingRouter.get('/positions/:id/effective-weight', async (req, res, next) => {
   const positionId = String(req.params.id);
   try {
      const weightData = await getPositionEffectiveWeight(positionId);
      sendSuccess(res, weightData);
   } catch (error) {
      if (error instanceof StakingPositionNotFoundError) {
         sendNotFound(res, 'Staking position');
         return;
      }
      logger.error(
         { error, positionId },
         'Failed to calculate position effective weight'
      );
      next(error);
   }
});

stakingRouter.all('/positions/:id/effective-weight', (_req, res) => {
   res.set('Allow', 'GET').sendStatus(405);
});

/**
 * GET /staking/positions/:id
 * Returns a staking position by ID with tier data and effective weight embedded.
 */
stakingRouter.get('/positions/:id', async (req, res, next) => {
   const positionId = String(req.params.id);
   try {
      const position = await getStakingPositionById(positionId);
      sendSuccess(res, position);
   } catch (error) {
      if (error instanceof StakingPositionNotFoundError) {
         sendNotFound(res, 'Staking position');
         return;
      }
      logger.error({ error, positionId }, 'Failed to fetch staking position');
      next(error);
   }
});

stakingRouter.all('/positions/:id', (_req, res) => {
   res.set('Allow', 'GET').sendStatus(405);
});

/**
 * GET /staking/positions
 * Returns the authenticated wallet's active (not unstaked) staking positions
 * with embedded tier data.
 */
stakingRouter.get(
   '/positions',
   requireJwtAuth,
   async (req: AuthenticatedRequest, res: Response, next) => {
      try {
         const positions = await getStakingPositions({
            wallet: req.user!.wallet,
         });
         sendSuccess(res, positions);
      } catch (error) {
         logger.error({ error }, 'Failed to list staking positions');
         next(error);
      }
   }
);

stakingRouter.all('/positions', (_req, res) => {
   res.set('Allow', 'GET').sendStatus(405);
});

export default stakingRouter;
