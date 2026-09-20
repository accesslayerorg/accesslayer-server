import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { StellarSignedRequest } from '../../middlewares/stellar-signature.middleware';
import { ErrorCode } from '../../constants/error.constants';
import {
   sendError,
   sendSuccess,
   sendValidationError,
} from '../../utils/api-response.utils';
import { sellGateway } from './sell.service';
import {
   assertTradingActive,
   TradingPausedError,
} from '../keys/key-trading.service';
import { prisma } from '../../utils/prisma.utils';
import { updateOwnership } from '../ownership/ownership.service';
import { invalidateCreatorDashboardCache } from './creator-dashboard.service';
import { logSellTransactionConfirmed } from '../../utils/sell-transaction-logger.utils';

export const sellSchema = z.object({
   quantity: z.number().int().positive(),
   min_proceeds_xlm: z.number().nonnegative().optional(),
   fee_xlm: z.number().nonnegative().default(0),
});

export type SellRequestBody = z.infer<typeof sellSchema>;

export async function httpSellCreatorKey(
   req: StellarSignedRequest,
   res: Response,
   next?: NextFunction
): Promise<void> {
   try {
      const body = req.body as SellRequestBody;
      const walletAddress =
         req.walletAddress ||
         (req as any).user?.wallet ||
         (req.headers['x-wallet-address'] as string);

      if (!walletAddress) {
         sendError(
            res,
            401,
            ErrorCode.UNAUTHORIZED,
            'Wallet authentication required'
         );
         return;
      }

      const rawCreatorId = req.params.id || (req.params as any).keyId;
      const creatorId = Array.isArray(rawCreatorId)
         ? rawCreatorId[0]
         : String(rawCreatorId);

      try {
         await assertTradingActive(creatorId);
      } catch (error) {
         if (error instanceof TradingPausedError) {
            sendError(res, 503, ErrorCode.INTERNAL_ERROR, error.message);
            return;
         }
         throw error;
      }

      // Check current key balance in the database
      const ownership = await prisma.keyOwnership.findUnique({
         where: {
            ownerAddress_creatorId: {
               ownerAddress: walletAddress,
               creatorId,
            },
         },
      });

      const currentBalance = ownership ? Number(ownership.balance) : 0;
      if (currentBalance < body.quantity) {
         sendError(
            res,
            400,
            ErrorCode.BAD_REQUEST,
            'Insufficient key balance to sell'
         );
         return;
      }

      // Submit sell and await confirmation
      const result = await sellGateway.submitSell({
         walletAddress,
         creatorId,
         quantity: body.quantity,
      });

      // Update seller's key balance in the database upon confirmed sell
      const updated = await updateOwnership(
         walletAddress,
         creatorId,
         -body.quantity,
         {
            event_type: 'sell',
         }
      );

      const newBalance = Number(updated.balance);

      try {
         await prisma.activity.create({
            data: {
               type: 'KEY_SOLD' as any,
               actor: walletAddress,
               creatorId,
               payload: {
                  quantity: body.quantity,
                  balanceAfter: newBalance.toString(),
                  txHash: result.transactionHash,
               },
            },
         });
      } catch {
         // Non-blocking activity recording
      }

      try {
         await invalidateCreatorDashboardCache(creatorId);
      } catch {
         // Non-blocking cache invalidation
      }

      try {
         const creatorProfile = await prisma.creatorProfile.findUnique({
            where: { id: creatorId },
            select: {
               user: {
                  select: { stellarWallet: { select: { address: true } } },
               },
            },
         });

         logSellTransactionConfirmed({
            sellerWallet: walletAddress,
            creatorWallet: creatorProfile?.user?.stellarWallet?.address ?? '',
            keyAmount: body.quantity,
            xlmReceivedStroops: 0n,
            newSupply: newBalance,
            txHash: result.transactionHash,
            confirmedAt: new Date(),
         });
      } catch {
         // Non-blocking logging
      }

      sendSuccess(
         res,
         {
            transactionHash: result.transactionHash,
            quantity: body.quantity,
            balance: newBalance,
            key_balance: newBalance,
            confirmed: true,
         },
         200
      );
   } catch (error) {
      if (next) {
         next(error);
      } else {
         sendError(
            res,
            500,
            ErrorCode.INTERNAL_ERROR,
            'Sell transaction failed'
         );
      }
   }
}

export async function httpGetCreatorKeyBalance(
   req: Request,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const rawCreatorId = req.params.id || (req.params as any).keyId;
      const creatorId = Array.isArray(rawCreatorId)
         ? rawCreatorId[0]
         : String(rawCreatorId);

      const wallet = (req.query.wallet ||
         req.query.ownerAddress ||
         req.query.walletAddress ||
         req.headers['x-wallet-address']) as string;

      if (!wallet) {
         sendValidationError(res, 'Wallet address is required', [
            {
               field: 'wallet',
               message: 'wallet query parameter or header is required',
            },
         ]);
         return;
      }

      const ownership = await prisma.keyOwnership.findUnique({
         where: {
            ownerAddress_creatorId: {
               ownerAddress: wallet,
               creatorId,
            },
         },
      });

      const balance = ownership ? Number(ownership.balance) : 0;
      sendSuccess(res, {
         creatorId,
         wallet,
         balance,
         key_balance: balance,
      });
   } catch (error) {
      next(error);
   }
}
