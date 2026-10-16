import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { StellarAddressSchema } from '../wallet/wallet.schemas';
import { getTraderDiscount } from './trader-discount.service';
import {
   sendSuccess,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';

const traderParamsSchema = z.object({
   wallet: StellarAddressSchema,
});

const tradersRouter = Router();

/**
 * GET /api/v1/traders/:wallet/discount
 * Returns the current volume discount tier, discount bps, and rolling 30d volume
 * for any wallet (cached with a 5-minute TTL per wallet).
 */
tradersRouter.get(
   '/:wallet/discount',
   async (req: Request, res: Response, next: NextFunction) => {
      const parsed = traderParamsSchema.safeParse(req.params);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid trader wallet address',
            zodIssuesToDetails(parsed.error.issues)
         );
         return;
      }

      try {
         const discount = await getTraderDiscount(parsed.data.wallet);
         sendSuccess(res, discount);
      } catch (error) {
         next(error);
      }
   }
);

export default tradersRouter;
