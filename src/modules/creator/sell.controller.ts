// src/modules/creator/sell.controller.ts
// Sell trade execution with server-side slippage protection (#884) and
// self-custody freeze enforcement (#885).
//
// The slippage re-check against the current bonding-curve price and the
// balance/supply updates happen inside a single Prisma transaction, so the
// check is atomic with trade execution and cannot race a concurrent trade.

import type { Response } from 'express';
import { z } from 'zod';
import type { StellarSignedRequest } from '../../middlewares/stellar-signature.middleware';
import { ErrorCode } from '../../constants/error.constants';
import {
   sendError,
   sendForbidden,
   sendNotFound,
   sendSuccess,
} from '../../utils/api-response.utils';
import { logger } from '../../utils/logger.utils';
import { prisma } from '../../utils/prisma.utils';
import { assertTradingActive, TradingPausedError } from '../keys/key-trading.service';
import {
   assertPositionNotFrozen,
   PositionFrozenError,
} from '../keys/key-freeze.service';
import {
   assertWalletNotSuspended,
   WalletSuspendedError,
} from '../indexer/flash-loan-guard-indexer.service';
import { getKeyFees, KeyNotFoundError } from '../keys/key-fees.service';
import { computeSellPayout, getSellUnitPrice } from '../../utils/pricing.utils';
import {
   computeCostBasisAfterSale,
   computeRealisedPnlForSale,
} from '../ownership/ownership.service';
import {
   logSlippageRejection,
   sendSlippageExceeded,
   SlippageExceededError,
} from '../trading/slippage.service';
import { invalidateCreatorDashboardCache } from './creator-dashboard.service';
import { invalidateHoldingsCache } from '../users/holdings.controller';

export const sellSchema = z.object({
   quantity: z.number().int().positive(),
   /**
    * Slippage protection (#884): minimum unit price (XLM) the seller will
    * accept. Required so every sell is protected against downward slippage.
    */
   min_price: z.number().nonnegative(),
   fee_xlm: z.number().nonnegative().default(0),
});

export type SellRequestBody = z.infer<typeof sellSchema>;

class InsufficientKeyBalanceForSellError extends Error {
   constructor() {
      super('Insufficient key balance for sell');
      this.name = 'InsufficientKeyBalanceForSellError';
   }
}

export async function httpSellCreatorKey(
   req: StellarSignedRequest,
   res: Response
): Promise<void> {
   // Body validated/stripped by validateBody(sellSchema) middleware.
   const body = req.body as SellRequestBody;
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

   // Self-custody freeze (#885): frozen positions cannot sell (403).
   try {
      await assertPositionNotFrozen(walletAddress, keyId);
   } catch (error) {
      if (error instanceof PositionFrozenError) {
         sendForbidden(res, error.message);
         return;
      }
      throw error;
   }

   // Flash loan guard (#938): wallets auto-suspended after repeated guard
   // violations cannot trade (403).
   try {
      await assertWalletNotSuspended(walletAddress);
   } catch (error) {
      if (error instanceof WalletSuspendedError) {
         sendForbidden(res, error.message);
         return;
      }
      throw error;
   }

   const creator = await prisma.creatorProfile.findUnique({
      where: { id: keyId },
      select: { id: true },
   });
   if (!creator) {
      sendNotFound(res, 'Key');
      return;
   }
   const { protocolFeeBps } = await getKeyFees(keyId);

   try {
      // Slippage check + trade execution in a single transaction (#884).
      const result = await prisma.$transaction(async tx => {
         const current = await tx.creatorProfile.findUnique({
            where: { id: creator.id },
            select: { circulatingSupply: true },
         });
         if (!current) {
            throw new KeyNotFoundError(keyId);
         }

         const ownership = await tx.keyOwnership.findUnique({
            where: {
               ownerAddress_creatorId: {
                  ownerAddress: walletAddress,
                  creatorId: creator.id,
               },
            },
            select: { balance: true, costBasis: true, realisedPnl: true },
         });
         const balance = Number((ownership as any)?.balance ?? 0);
         const costBasis = Number((ownership as any)?.costBasis ?? 0);
         const prevRealised = Number((ownership as any)?.realisedPnl ?? 0);
         if (balance < body.quantity) {
            throw new InsufficientKeyBalanceForSellError();
         }

         const supply = Number(current.circulatingSupply);
         const currentPriceXlm =
            Number(getSellUnitPrice(supply, protocolFeeBps)) / 10_000_000;
         if (currentPriceXlm < body.min_price) {
            throw new SlippageExceededError(
               'sell',
               String(currentPriceXlm),
               String(body.min_price)
            );
         }

         const payoutStroops = computeSellPayout(
            supply,
            body.quantity,
            protocolFeeBps
         );
         const payoutXlm = Number(payoutStroops) / 10_000_000;
         const newSupply = supply - body.quantity;
         const newBalance = balance - body.quantity;

         // Persist realised P&L at execution time (#897). Partial sells keep
         // the average cost basis; full sells reset it to zero.
         const realisedForTrade = computeRealisedPnlForSale(
            costBasis,
            currentPriceXlm,
            body.quantity
         );
         const newCostBasis = computeCostBasisAfterSale(
            costBasis,
            balance,
            body.quantity
         );
         const newRealised = prevRealised + realisedForTrade;

         await (tx.keyOwnership.update as any)({
            where: {
               ownerAddress_creatorId: {
                  ownerAddress: walletAddress,
                  creatorId: creator.id,
               },
            },
            data: {
               balance: newBalance,
               costBasis: newCostBasis,
               realisedPnl: newRealised,
            },
         });
         await tx.creatorProfile.update({
            where: { id: creator.id },
            data: { circulatingSupply: newSupply },
         });
         await tx.activity.create({
            data: {
               type: 'KEY_SOLD',
               actor: walletAddress,
               creatorId: creator.id,
               payload: {
                  keyId: creator.id,
                  quantity: body.quantity,
                  minPrice: body.min_price,
                  currentPrice: currentPriceXlm,
                  payoutXlm,
                  costBasis,
                  realisedPnl: realisedForTrade,
                  balanceAfter: newBalance,
                  circulatingSupplyAfter: newSupply,
               },
            },
         });
         await tx.activityLog.create({
            data: {
               type: 'sell',
               actor: walletAddress,
               keyId: creator.id,
               amount: payoutXlm,
               payload: {
                  quantity: body.quantity,
                  minPrice: body.min_price,
                  currentPrice: currentPriceXlm,
                  payoutXlm,
                  realisedPnl: realisedForTrade,
               },
            },
         });

         return {
            quantity: body.quantity,
            minPrice: body.min_price,
            currentPrice: currentPriceXlm,
            payoutXlm,
            realisedPnl: realisedForTrade,
            balanceAfter: newBalance,
            circulatingSupplyAfter: newSupply,
         };
      });

      await Promise.all([
         invalidateHoldingsCache(walletAddress),
         invalidateCreatorDashboardCache(creator.id),
      ]);
      sendSuccess(res, result, 200);
   } catch (error) {
      if (error instanceof SlippageExceededError) {
         logSlippageRejection({
            side: 'sell',
            wallet: walletAddress,
            keyId: creator.id,
            currentPrice: error.currentPrice,
            submittedPrice: error.submittedPrice,
            unit: 'XLM',
            requestId: req.requestId,
         });
         sendSlippageExceeded(res, {
            side: 'sell',
            currentPrice: error.currentPrice,
            submittedPrice: error.submittedPrice,
            unit: 'XLM',
         });
         return;
      }
      if (error instanceof InsufficientKeyBalanceForSellError) {
         sendError(res, 400, ErrorCode.BAD_REQUEST, error.message);
         return;
      }
      logger.error(
         { error, keyId, wallet: walletAddress },
         'Key sell failed'
      );
      throw error;
   }
}
