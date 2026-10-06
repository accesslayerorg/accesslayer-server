import { Router } from 'express';
import {
   sendSuccess,
   sendNotFound,
   sendForbidden,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import {
   requireJwtAuth,
   AuthenticatedRequest,
} from '../../middlewares/jwt-auth.middleware';
import { LpPositionsByWalletQuerySchema } from './lp.schemas';
import {
   getLpPositionsByWallet,
   getLpPositionById,
   getLpPoolSummary,
   LpPositionNotFoundError,
} from './lp.service';

const router = Router();

/**
 * GET /lp/positions?wallet=<wallet>
 * Requires JWT auth; the authenticated wallet must match the query wallet.
 * All active LP positions for that wallet with sharePercent and accruedRewards.
 */
router.get(
   '/positions',
   requireJwtAuth,
   async (req: AuthenticatedRequest, res, next) => {
      const parsed = LpPositionsByWalletQuerySchema.safeParse(req.query);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid query parameters',
            zodIssuesToDetails(parsed.error.issues)
         );
         return;
      }

      if (req.user!.wallet !== parsed.data.wallet) {
         sendForbidden(res, 'Wallet does not match the authenticated wallet');
         return;
      }

      try {
         const positions = await getLpPositionsByWallet(parsed.data.wallet);
         sendSuccess(res, { items: positions });
      } catch (error) {
         next(error);
      }
   }
);

/**
 * GET /lp/positions/:lpId
 * Requires JWT auth; 404 both when the position doesn't exist and when it
 * isn't owned by the authenticated wallet (no existence leakage).
 */
router.get(
   '/positions/:lpId',
   requireJwtAuth,
   async (req: AuthenticatedRequest, res, next) => {
      try {
         const position = await getLpPositionById(
            String(req.params.lpId),
            req.user!.wallet
         );
         sendSuccess(res, position);
      } catch (error) {
         if (error instanceof LpPositionNotFoundError) {
            sendNotFound(res, 'LP position');
            return;
         }
         next(error);
      }
   }
);

/**
 * GET /lp/pool/:keyId
 * Public (aggregate data, no auth required). Total pool size and a
 * simplified APR estimate.
 */
router.get('/pool/:keyId', async (req, res, next) => {
   try {
      const pool = await getLpPoolSummary(String(req.params.keyId));
      sendSuccess(res, pool);
   } catch (error) {
      next(error);
   }
});

export default router;
