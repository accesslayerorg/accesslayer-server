import type { Response } from 'express';
import { z } from 'zod';
import type { StellarSignedRequest } from '../../middlewares/stellar-signature.middleware';
import { ErrorCode } from '../../constants/error.constants';
import {
   sendError,
   sendSuccess,
   sendForbidden,
} from '../../utils/api-response.utils';
import { buyGateway } from './buy.service';
import {
   assertTradingActive,
   TradingPausedError,
} from '../keys/key-trading.service';
import {
   assertPositionNotFrozen,
   PositionFrozenError,
} from '../keys/key-freeze.service';
import { getKeyFees } from '../keys/key-fees.service';
import { prisma } from '../../utils/prisma.utils';
import { getBuyUnitPrice } from '../../utils/pricing.utils';
import {
   logSlippageRejection,
   sendSlippageExceeded,
} from '../trading/slippage.service';

export const buySchema = z.object({
   quantity: z.number().int().positive(),
   key_cost_xlm: z.number().nonnegative(),
   fee_xlm: z.number().nonnegative().default(0),
   /**
    * Slippage protection (#884): maximum unit price (XLM) the buyer is
    * willing to pay. When submitted, the trade is rejected with 409 if the
    * current bonding-curve price exceeds it.
    */
   max_price: z.number().nonnegative().optional(),
});

export type BuyRequestBody = z.infer<typeof buySchema>;

export async function httpBuyCreatorKey(
   req: StellarSignedRequest,
   res: Response
): Promise<void> {
   // Body is already validated and stripped of unknown fields by the
   // validateBody(buySchema) middleware on this route.
   const body = req.body as BuyRequestBody;

   const walletAddress = req.walletAddress!;
   const keyId = String(req.params.id);
   try {
      await assertTradingActive(keyId);
   } catch (error) {
      if (error instanceof TradingPausedError) {
         sendError(res, 503, ErrorCode.INTERNAL_ERROR, error.message);
         return;
      }
      throw error;
   }

   // Self-custody freeze (#885): frozen positions cannot trade (403).
   try {
      await assertPositionNotFrozen(walletAddress, keyId);
   } catch (error) {
      if (error instanceof PositionFrozenError) {
         sendForbidden(res, error.message);
         return;
      }
      throw error;
   }

   const required = body.key_cost_xlm * body.quantity + body.fee_xlm;
   const balance = await buyGateway.getXlmBalance(walletAddress);
   if (balance < required) {
      sendError(
         res,
         422,
         ErrorCode.INSUFFICIENT_BALANCE,
         'Wallet does not have enough XLM for the purchase and fees'
      );
      return;
   }

   // Slippage check (#884): performed immediately before trade submission so
   // the check and execution are adjacent with no intervening awaits other
   // than the gateway call itself (on-chain settlement is the transaction
   // boundary for buys).
   if (body.max_price !== undefined) {
      const creator = await prisma.creatorProfile.findUnique({
         where: { id: keyId },
         select: { circulatingSupply: true },
      });
      if (creator) {
         const { protocolFeeBps } = await getKeyFees(keyId);
         const supply = Number(creator.circulatingSupply);
         const currentPriceXlm =
            Number(getBuyUnitPrice(supply, protocolFeeBps)) / 10_000_000;
         if (currentPriceXlm > body.max_price) {
            const currentPrice = String(currentPriceXlm);
            const submittedPrice = String(body.max_price);
            logSlippageRejection({
               side: 'buy',
               wallet: walletAddress,
               keyId,
               currentPrice,
               submittedPrice,
               unit: 'XLM',
               requestId: req.requestId,
            });
            sendSlippageExceeded(res, {
               side: 'buy',
               currentPrice,
               submittedPrice,
               unit: 'XLM',
            });
            return;
         }
      }
   }

   const result = await buyGateway.submitBuy({
      walletAddress,
      creatorId: keyId,
      quantity: body.quantity,
   });
   sendSuccess(res, result, 200);
}
