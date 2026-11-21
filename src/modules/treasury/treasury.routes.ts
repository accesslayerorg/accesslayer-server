// src/modules/treasury/treasury.routes.ts
// Admin dashboard read routes for the platform treasury (#1181).
// Mounted under /admin/treasury behind adminGuard in admin.routes.ts.

import { Router } from 'express';
import { z } from 'zod';
import {
   sendPaginatedSuccess,
   sendSuccess,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import {
   getTreasurySummary,
   listTreasuryAllocations,
   listTreasuryInflows,
} from './treasury.service';

export const treasuryRouter = Router();

const pageQuerySchema = z.object({
   page: z.coerce.number().int().min(1).max(100000).default(1),
   limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** GET /admin/treasury — total balance and per-source breakdown. */
treasuryRouter.get('/', async (_req, res, next) => {
   try {
      sendSuccess(res, await getTreasurySummary());
   } catch (error) {
      next(error);
   }
});

/** GET /admin/treasury/allocations — paginated FundsAllocated history. */
treasuryRouter.get('/allocations', async (req, res, next) => {
   const query = pageQuerySchema.safeParse(req.query);
   if (!query.success) {
      sendValidationError(
         res,
         'Invalid query',
         zodIssuesToDetails(query.error.issues)
      );
      return;
   }
   try {
      const { data, meta } = await listTreasuryAllocations(query.data);
      sendPaginatedSuccess(res, data, meta);
   } catch (error) {
      next(error);
   }
});

/** GET /admin/treasury/inflows — paginated FeeReceived history. */
treasuryRouter.get('/inflows', async (req, res, next) => {
   const query = pageQuerySchema.safeParse(req.query);
   if (!query.success) {
      sendValidationError(
         res,
         'Invalid query',
         zodIssuesToDetails(query.error.issues)
      );
      return;
   }
   try {
      const { data, meta } = await listTreasuryInflows(query.data);
      sendPaginatedSuccess(res, data, meta);
   } catch (error) {
      next(error);
   }
});
