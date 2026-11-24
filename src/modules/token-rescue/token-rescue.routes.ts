// src/modules/token-rescue/token-rescue.routes.ts
import { Router } from 'express';
import { z } from 'zod';
import { adminGuard, AdminRequest } from '../../middlewares/admin-guard.middleware';
import {
   sendSuccess,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import {
   getTokenRescueTotals,
   InvalidTokenRescueCursorError,
   listTokenRescuesForAdmin,
   TOKEN_RESCUE_DEFAULT_LIMIT,
   TOKEN_RESCUE_MAX_LIMIT,
} from './token-rescue.service';

const adminRescueQuerySchema = z.object({
   token: z.string().min(1).max(128).optional(),
   cursor: z.string().min(1).max(64).optional(),
   limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(TOKEN_RESCUE_MAX_LIMIT)
      .optional()
      .default(TOKEN_RESCUE_DEFAULT_LIMIT),
});

/**
 * Admin rescue report, mounted under /admin. Non-admin tokens get 403 from
 * adminGuard.
 * GET /admin/rescues?cursor=&token=&limit=
 */
export const tokenRescueAdminRouter = Router();

tokenRescueAdminRouter.get(
   '/rescues',
   adminGuard,
   async (req: AdminRequest, res, next) => {
      const parsed = adminRescueQuerySchema.safeParse(req.query);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid query parameters',
            zodIssuesToDetails(parsed.error.issues)
         );
         return;
      }

      try {
         const page = await listTokenRescuesForAdmin(parsed.data);
         sendSuccess(res, page);
      } catch (error) {
         if (error instanceof InvalidTokenRescueCursorError) {
            sendValidationError(res, 'Invalid cursor', [
               {
                  field: 'cursor',
                  message: 'Cursor does not match a rescue record',
               },
            ]);
            return;
         }
         next(error);
      }
   }
);

/**
 * Public transparency report, no authentication. Returns per-token totals
 * only, so recipient, admin and txHash are never exposed.
 * GET /transparency/rescues
 */
export const tokenRescuePublicRouter = Router();

tokenRescuePublicRouter.get('/rescues', async (_req, res, next) => {
   try {
      const totals = await getTokenRescueTotals();
      sendSuccess(res, { totals });
   } catch (error) {
      next(error);
   }
});
