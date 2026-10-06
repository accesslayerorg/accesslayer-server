// src/modules/revenue/revenue.routes.ts
// Claim endpoints for the protocol revenue distribution pool (#883).
import { Router } from 'express';
import {
   sendError,
   sendSuccess,
} from '../../utils/api-response.utils';
import { ErrorCode } from '../../constants/error.constants';
import {
   requireJwtAuth,
   AuthenticatedRequest,
} from '../../middlewares/jwt-auth.middleware';
import { logger } from '../../utils/logger.utils';
import {
   AlreadyClaimedError,
   claimRevenue,
   getClaimableRevenue,
   NothingToClaimError,
} from './revenue.service';

const revenueRouter = Router();

/**
 * GET /api/v1/revenue/claimable
 * Unclaimed protocol revenue for the authenticated wallet (latest ended
 * distribution cycle), proportional to stake weight.
 */
revenueRouter.get(
   '/claimable',
   requireJwtAuth,
   async (req: AuthenticatedRequest, res, next) => {
      try {
         const wallet = req.user!.wallet;
         sendSuccess(res, await getClaimableRevenue(wallet));
      } catch (error) {
         logger.error({ error }, 'Failed to fetch claimable revenue');
         next(error);
      }
   }
);
revenueRouter.all('/claimable', (_req, res) => {
   res.set('Allow', 'GET').sendStatus(405);
});

/**
 * POST /api/v1/revenue/claim
 * Process the authenticated wallet's claim for the latest ended cycle.
 * Returns 409 when the wallet already claimed in the same cycle.
 */
revenueRouter.post(
   '/claim',
   requireJwtAuth,
   async (req: AuthenticatedRequest, res, next) => {
      try {
         const wallet = req.user!.wallet;
         const result = await claimRevenue(wallet);
         sendSuccess(res, result, 201);
      } catch (error) {
         if (error instanceof AlreadyClaimedError) {
            sendError(res, 409, ErrorCode.CONFLICT, error.message);
            return;
         }
         if (error instanceof NothingToClaimError) {
            sendError(res, 400, ErrorCode.BAD_REQUEST, error.message);
            return;
         }
         logger.error({ error, user: req.user }, 'Revenue claim failed');
         next(error);
      }
   }
);
revenueRouter.all('/claim', (_req, res) => {
   res.set('Allow', 'POST').sendStatus(405);
});

export default revenueRouter;
