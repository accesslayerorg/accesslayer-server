// src/modules/orders/escrow-order.routes.ts
import { Router } from 'express';
import { z } from 'zod';
import { sendSuccess, sendValidationError } from '../../utils/api-response.utils';
import {
   getKeeperStats,
   listEscrowOrders,
   listFills,
} from './escrow-order.service';

const escrowOrderRouter = Router();

const listQuery = z.object({
   wallet: z.string().optional(),
   status: z.string().optional(),
   cursor: z.string().optional(),
   limit: z.coerce.number().int().min(1).max(100).optional(),
});

/**
 * GET /api/v1/orders/escrow?wallet=&status=&cursor=
 * List escrow limit orders with locked amounts, status and optional expiry (#1351).
 */
escrowOrderRouter.get('/escrow', async (req, res, next) => {
   try {
      const parsed = listQuery.safeParse(req.query);
      if (!parsed.success) {
         return sendValidationError(res, 'Invalid query', [
            { message: parsed.error.message },
         ]);
      }
      return sendSuccess(res, await listEscrowOrders(parsed.data));
   } catch (error) { next(error); }
});

/**
 * GET /api/v1/orders/escrow/:id/fills
 * Fills for a single escrow order including price achieved and keeper reward (#1351).
 */
escrowOrderRouter.get('/escrow/:id/fills', async (req, res, next) => {
   try {
      return sendSuccess(res, await listFills(String(req.params.id)));
   } catch (error) { next(error); }
});

/**
 * GET /api/v1/orders/escrow/keepers
 * Keeper leaderboard — total fills and total reward paid per keeper (#1351).
 */
escrowOrderRouter.get('/escrow/keepers', async (_req, res, next) => {
   try {
      return sendSuccess(res, await getKeeperStats());
   } catch (error) { next(error); }
});

export default escrowOrderRouter;
