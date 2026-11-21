// src/modules/staking/vault.routes.ts
// Staking vault endpoints. Position and rewards require a JWT and use the
// token's wallet (no :wallet param); the vault summary is public. Pricing is
// live, so responses are never cached.

import { NextFunction, Response, Router } from 'express';
import {
   AuthenticatedRequest,
   requireJwtAuth,
} from '../../middlewares/jwt-auth.middleware';
import { ErrorCode, sendError, sendSuccess } from '../../utils/api-response.utils';
import {
   getVaultPosition,
   getVaultRewards,
   getVaultSummary,
} from './vault.service';

const stakingRouter = Router();

function walletOf(req: AuthenticatedRequest, res: Response): string | null {
   const wallet = req.user?.wallet;
   if (!wallet) {
      sendError(res, 401, ErrorCode.UNAUTHORIZED, 'Authentication required');
      return null;
   }
   return wallet;
}

/** GET /staking/vault/position — authenticated wallet's share and key breakdown. */
stakingRouter.get(
   '/vault/position',
   requireJwtAuth,
   async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      const wallet = walletOf(req, res);
      if (!wallet) return;
      try {
         res.setHeader('Cache-Control', 'no-store');
         sendSuccess(res, await getVaultPosition(wallet));
      } catch (error) {
         next(error);
      }
   }
);

/** GET /staking/vault/rewards — authenticated wallet's claimable vault rewards. */
stakingRouter.get(
   '/vault/rewards',
   requireJwtAuth,
   async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      const wallet = walletOf(req, res);
      if (!wallet) return;
      try {
         res.setHeader('Cache-Control', 'no-store');
         sendSuccess(res, await getVaultRewards(wallet));
      } catch (error) {
         next(error);
      }
   }
);

/** GET /staking/vault/summary — public vault TVL and depositor count. */
stakingRouter.get(
   '/vault/summary',
   async (_req, res: Response, next: NextFunction) => {
      try {
         res.setHeader('Cache-Control', 'no-store');
         sendSuccess(res, await getVaultSummary());
      } catch (error) {
         next(error);
      }
   }
);

export default stakingRouter;
