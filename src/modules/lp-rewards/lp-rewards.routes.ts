// src/modules/lp-rewards/lp-rewards.routes.ts
// Key LP reward endpoints (#1196). Mounted under /keys.

import { Router } from 'express';
import {
   sendConflict,
   sendNotFound,
   sendSuccess,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import { requireWalletParamMatch } from '../../middlewares/jwt-auth.middleware';
import { keyLpWalletParamsSchema } from './lp-rewards.schemas';
import {
   claimKeyLpRewards,
   ConcurrentClaimError,
   getKeyLpPosition,
   KeyLpPositionNotFoundError,
   LpRewardsKeyNotFoundError,
   NothingToClaimError,
} from './lp-rewards.service';

const keyLpRewardsRouter = Router();

/**
 * GET /keys/:keyId/lp/:wallet
 * Public. LP position for a wallet: lp_tokens, pool_share_pct,
 * accrued_rewards and claimable (accrued - claimed).
 */
keyLpRewardsRouter.get('/:keyId/lp/:wallet', async (req, res, next) => {
   const params = keyLpWalletParamsSchema.safeParse(req.params);
   if (!params.success) {
      sendValidationError(res, 'Invalid path parameters', zodIssuesToDetails(params.error.issues));
      return;
   }
   try {
      sendSuccess(res, await getKeyLpPosition(params.data.keyId, params.data.wallet));
   } catch (error) {
      if (error instanceof LpRewardsKeyNotFoundError) return sendNotFound(res, 'Key');
      if (error instanceof KeyLpPositionNotFoundError) return sendNotFound(res, 'LP position');
      next(error);
   }
});

/**
 * POST /keys/:keyId/lp/:wallet/claim
 * Requires a JWT for the same wallet. Transfers the full claimable balance
 * to the wallet and resets claimable to zero. 409 when nothing is claimable
 * or a concurrent claim won the race.
 */
keyLpRewardsRouter.post(
   '/:keyId/lp/:wallet/claim',
   requireWalletParamMatch('wallet'),
   async (req, res, next) => {
      const params = keyLpWalletParamsSchema.safeParse(req.params);
      if (!params.success) {
         sendValidationError(res, 'Invalid path parameters', zodIssuesToDetails(params.error.issues));
         return;
      }
      try {
         sendSuccess(res, await claimKeyLpRewards(params.data.keyId, params.data.wallet));
      } catch (error) {
         if (error instanceof LpRewardsKeyNotFoundError) return sendNotFound(res, 'Key');
         if (error instanceof KeyLpPositionNotFoundError) return sendNotFound(res, 'LP position');
         if (error instanceof NothingToClaimError || error instanceof ConcurrentClaimError) {
            return sendConflict(res, error.message);
         }
         next(error);
      }
   }
);

export default keyLpRewardsRouter;
