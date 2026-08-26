// src/modules/trade/trade.controller.ts
// POST /trade/buy and POST /trade/sell handlers.

import { z } from 'zod';
import { AsyncController } from '../../types/auth.types';
import { sendSuccess, sendValidationError } from '../../utils/api-response.utils';
import {
   executeTrade,
   resolveCreatorId,
   type TradeSide,
} from './trade.service';

const TradeBodySchema = z.object({
   keyId: z.string().min(1),
   amount: z.number().positive(),
   price: z.number().min(0),
   txHash: z.string().min(1),
});

/**
 * Shared handler for buy/sell. `side` is fixed by the route.
 */
function makeTradeHandler(side: TradeSide): AsyncController {
   return async (req, res, next) => {
      try {
         const authWallet = (req as { authWallet?: string }).authWallet;
         if (!authWallet) {
            return sendValidationError(res, 'Authenticated wallet is required');
         }

         const parsed = TradeBodySchema.safeParse(req.body);
         if (!parsed.success) {
            return sendValidationError(
               res,
               'Invalid trade payload',
               parsed.error.issues.map((i) => ({
                  field: i.path.join('.'),
                  message: i.message,
               }))
            );
         }

         const { keyId, amount, price, txHash } = parsed.data;

         const creatorId = await resolveCreatorId(keyId);
         if (!creatorId) {
            return sendValidationError(res, 'Unknown creator key', [
               { field: 'keyId', message: 'No creator found for this key' },
            ]);
         }

         const result = await executeTrade({
            keyId,
            creatorId,
            wallet: authWallet,
            side,
            amount,
            price,
            txHash,
         });

         return sendSuccess(res, result);
      } catch (error) {
         next(error);
      }
   };
}

export const httpBuyKey = makeTradeHandler('BUY');
export const httpSellKey = makeTradeHandler('SELL');
