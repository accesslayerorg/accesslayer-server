import { Router } from 'express';
import { z } from 'zod';
import {
   sendSuccess,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import {
   getRevenueDistributions,
   getWalletRevenueDistributions,
} from './revenue-distributions.service';

const router = Router();
const paginationQuerySchema = z.object({
   limit: z.coerce.number().int().positive().max(100).optional().default(50),
   cursor: z.string().min(1).optional(),
});
const stellarWalletSchema = z.string().regex(/^G[A-Z2-7]{55}$/);

router.get('/:keyId/revenue-distributions', async (req, res, next) => {
   const parsed = paginationQuerySchema.safeParse(req.query);
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
         await getRevenueDistributions({
            keyId: req.params.keyId,
            ...parsed.data,
         })
      );
   } catch (error) {
      next(error);
   }
});

router.get('/:keyId/revenue-distributions/:wallet', async (req, res, next) => {
   const parsed = stellarWalletSchema.safeParse(req.params.wallet);
   if (!parsed.success) {
      sendValidationError(res, 'Invalid wallet address', [
         { field: 'wallet', message: 'Invalid Stellar wallet address' },
      ]);
      return;
   }
   try {
      sendSuccess(
         res,
         await getWalletRevenueDistributions({
            keyId: req.params.keyId,
            wallet: parsed.data,
         })
      );
   } catch (error) {
      next(error);
   }
});

export default router;
