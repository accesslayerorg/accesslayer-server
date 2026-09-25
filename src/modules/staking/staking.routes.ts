// src/modules/staking/staking.routes.ts
import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
   sendError,
   sendSuccess,
   sendValidationError,
   sendForbidden,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import { ErrorCode } from '../../constants/error.constants';
import {
   requireJwtAuth,
   AuthenticatedRequest,
} from '../../middlewares/jwt-auth.middleware';
import {
   createStake,
   unstake,
   getStakingPositions,
   KeyNotFoundError,
   InsufficientBalanceError,
   LockPeriodNotExpiredError,
   InvalidLockPeriodError,
} from './staking.service';
import { stakeBodySchema, unstakeBodySchema } from './staking.schemas';

const router = Router();

/**
 * POST /api/v1/staking/stake
 * Stake creator keys with a lock period.
 */
router.post(
   '/stake',
   requireJwtAuth,
   async (req: AuthenticatedRequest, res, next) => {
      try {
         const wallet = req.user!.wallet;
         const parsed = stakeBodySchema.safeParse(req.body);

         if (!parsed.success) {
            sendValidationError(
               res,
               'Invalid stake request body',
               zodIssuesToDetails(parsed.error.issues)
            );
            return;
         }

         const result = await createStake(wallet, parsed.data);
         sendSuccess(res, result, 201);
      } catch (error) {
         if (error instanceof KeyNotFoundError) {
            sendError(res, 404, ErrorCode.NOT_FOUND, error.message);
            return;
         }
         if (error instanceof InsufficientBalanceError) {
            sendError(res, 400, ErrorCode.BAD_REQUEST, error.message);
            return;
         }
         if (error instanceof InvalidLockPeriodError) {
            sendError(res, 400, ErrorCode.BAD_REQUEST, error.message);
            return;
         }
         next(error);
      }
   }
);

/**
 * POST /api/v1/staking/unstake
 * Unstake creator keys after lock period expires.
 */
router.post(
   '/unstake',
   requireJwtAuth,
   async (req: AuthenticatedRequest, res, next) => {
      try {
         const wallet = req.user!.wallet;
         const parsed = unstakeBodySchema.safeParse(req.body);

         if (!parsed.success) {
            sendValidationError(
               res,
               'Invalid unstake request body',
               zodIssuesToDetails(parsed.error.issues)
            );
            return;
         }

         const result = await unstake(wallet, parsed.data);
         sendSuccess(res, result, 200);
      } catch (error) {
         if (error instanceof LockPeriodNotExpiredError) {
            sendForbidden(res, error.message);
            return;
         }
         if (error instanceof InsufficientBalanceError) {
            sendError(res, 400, ErrorCode.BAD_REQUEST, error.message);
            return;
         }
         next(error);
      }
   }
);

/**
 * GET /api/v1/staking/positions
 * Get all active staking positions for authenticated wallet.
 */
router.get(
   '/positions',
   requireJwtAuth,
   async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
         const wallet = req.user!.wallet;
         const positions = await getStakingPositions(wallet);
         sendSuccess(res, positions);
      } catch (error) {
         next(error);
      }
   }
);

export default router;
