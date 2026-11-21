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
import {
   LpPositionsByWalletQuerySchema,
   LpPositionsByWalletParamsSchema,
   LpPositionDetailParamsSchema,
} from './lp.schemas';
import {
   getLpPositionsByWallet,
   getLpPositionById,
   getLpPoolSummary,
   getLpPositionsWithLiveRewards,
   getLpPositionDetailWithLiveRewards,
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

/**
 * GET /lp/:wallet/positions
 * Requires JWT auth; authenticated wallet must match the path wallet param.
 * Returns active LP positions with live rewards for the specified wallet.
 */
router.get(
   '/:wallet/positions',
   requireJwtAuth,
   async (req: AuthenticatedRequest, res, next) => {
      const parsed = LpPositionsByWalletParamsSchema.safeParse(req.params);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid path parameters',
            zodIssuesToDetails(parsed.error.issues)
         );
         return;
      }

      if (req.user!.wallet !== parsed.data.wallet) {
         sendForbidden(res, 'Wallet does not match the authenticated wallet');
         return;
      }

      try {
         const items = await getLpPositionsWithLiveRewards(parsed.data.wallet);
         sendSuccess(res, { items });
      } catch (error) {
         next(error);
      }
   }
);

/**
 * GET /lp/:wallet/positions/:positionId
 * Requires JWT auth; authenticated wallet must match the path wallet param.
 * Returns position detail with live rewards if active. 404 if not found or not owned.
 */
router.get(
   '/:wallet/positions/:positionId',
   requireJwtAuth,
   async (req: AuthenticatedRequest, res, next) => {
      const parsed = LpPositionDetailParamsSchema.safeParse(req.params);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid path parameters',
            zodIssuesToDetails(parsed.error.issues)
         );
         return;
      }

      if (req.user!.wallet !== parsed.data.wallet) {
         sendForbidden(res, 'Wallet does not match the authenticated wallet');
         return;
      }

      try {
         const position = await getLpPositionDetailWithLiveRewards(
            parsed.data.positionId,
            parsed.data.wallet
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

export default router;
