// src/modules/traders/traders.routes.ts
// Router for trader-specific endpoints (#1030).

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { StellarAddressSchema } from '../wallet/wallet.schemas';
import {
   sendSuccess,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import { getTraderDiscount } from './trader-discount.service';
import { logger } from '../../utils/logger.utils';

const traderDiscountParamsSchema = z.object({
   wallet: StellarAddressSchema,
});

const tradersRouter = Router();

/**
 * GET /api/v1/traders/:wallet/discount
 * GET /traders/:wallet/discount
 *
 * Returns the current volume discount tier, discount bps, and 30-day rolling
 * volume for any wallet address. Used by the fee computation service.
 * Cached in Redis with a 5-minute TTL per wallet (#1030).
 *
 * No authentication required.
 */
tradersRouter.get(
   '/:wallet/discount',
   async (req: Request, res: Response, next: NextFunction) => {
      const parsed = traderDiscountParamsSchema.safeParse(req.params);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid wallet address parameter',
            zodIssuesToDetails(parsed.error.issues)
         );
         return;
      }

      try {
         const discount = await getTraderDiscount(parsed.data.wallet);
         sendSuccess(res, discount);
      } catch (error) {
         logger.error(
            { error, wallet: req.params.wallet },
            'Failed to fetch trader discount tier'
         );
         next(error);
      }
   }
);

export default tradersRouter;
