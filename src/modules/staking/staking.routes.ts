// src/modules/staking/staking.routes.ts
// Staking reward multiplier tiers and position effective weight endpoints (#942).

import { Router } from 'express';
import { z } from 'zod';
import {
   sendNotFound,
   sendSuccess,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import { logger } from '../../utils/logger.utils';
import {
   getMultiplierTiers,
   getPositionEffectiveWeight,
   getStakingPositionById,
   getStakingPositions,
   StakingPositionNotFoundError,
} from './staking.service';

const stakingRouter = Router();

const positionsQuerySchema = z.object({
   wallet: z.string().min(1).optional(),
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
 * Returns staking positions (optionally filtered by ?wallet=) with embedded tier data.
 */
stakingRouter.get('/positions', async (req, res, next) => {
   const parsed = positionsQuerySchema.safeParse(req.query);
   if (!parsed.success) {
      sendValidationError(
         res,
         'Invalid query parameters',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }

   try {
      const positions = await getStakingPositions(parsed.data);
      sendSuccess(res, positions);
   } catch (error) {
      logger.error({ error }, 'Failed to list staking positions');
      next(error);
   }
});

stakingRouter.all('/positions', (_req, res) => {
   res.set('Allow', 'GET').sendStatus(405);
});

export default stakingRouter;
