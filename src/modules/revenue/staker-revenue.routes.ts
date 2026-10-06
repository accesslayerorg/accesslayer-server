// src/modules/revenue/staker-revenue.routes.ts
// Protocol revenue distribution history for a staker wallet (#875).
import { Router } from 'express';
import { z } from 'zod';
import {
   sendSuccess,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import {
   AuthenticatedRequest,
   requireWalletParamMatch,
} from '../../middlewares/jwt-auth.middleware';
import { getProtocolRevenueForWallet } from './protocol-revenue.service';

const stakerRouter = Router();

const protocolRevenueQuerySchema = z.object({
   limit: z.coerce.number().int().positive().max(100).optional().default(50),
   cursor: z.string().min(1).optional(),
});

/**
 * GET /api/v1/staker/:wallet/protocol-revenue?cursor=&limit=
 * Past protocol revenue distributions and the amount the wallet received,
 * newest first. The JWT wallet must match the path wallet (401 otherwise).
 */
stakerRouter.get(
   '/:wallet/protocol-revenue',
   requireWalletParamMatch('wallet'),
   async (req: AuthenticatedRequest, res, next) => {
      const parsed = protocolRevenueQuerySchema.safeParse(req.query);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid query parameters',
            zodIssuesToDetails(parsed.error.issues)
         );
         return;
      }
      try {
         sendSuccess(
            res,
            await getProtocolRevenueForWallet({
               wallet: String(req.params.wallet),
               ...parsed.data,
            })
         );
      } catch (error) {
         next(error);
      }
   }
);

export default stakerRouter;
