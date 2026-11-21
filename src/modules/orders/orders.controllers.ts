import { Response, NextFunction } from 'express';
import { randomBytes } from 'crypto';
import { Prisma } from '@prisma/client';
import { AuthenticatedRequest } from '../../middlewares/jwt-auth.middleware';
import { CreateOrderSchema } from './orders.schemas';
import { prisma } from '../../utils/prisma.utils';
import {
   sendSuccess,
   sendNotFound,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';

export async function httpCreateOrder(
   req: AuthenticatedRequest,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const parsed = CreateOrderSchema.safeParse(req.body);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid order request body',
            zodIssuesToDetails(parsed.error.issues)
         );
         return;
      }

      const wallet = req.user?.wallet;
      if (!wallet) {
         res.status(401).json({ success: false, message: 'Unauthorized' });
         return;
      }

      const { keyId, quantity, side, price } = parsed.data;

      const creator = await prisma.creatorProfile.findFirst({
         where: { OR: [{ id: keyId }, { handle: keyId }] },
      });

      if (!creator) {
         sendNotFound(res, 'Key');
         return;
      }

      const qtyStr = String(quantity);
      const priceStr = price !== undefined ? String(price) : '1.0';
      const qtyDec = new Prisma.Decimal(qtyStr);

      const trade = await prisma.trade.create({
         data: {
            buyer: wallet,
            creatorId: creator.id,
            quantity: qtyStr,
            price: priceStr,
            ledger: Math.floor(Date.now() / 1000),
            txHash: `0x${randomBytes(32).toString('hex')}`,
            timestamp: new Date(),
            paymentAsset: 'XLM',
            type: 'single',
         },
      });

      await prisma.keyOwnership.upsert({
         where: {
            ownerAddress_creatorId: {
               ownerAddress: wallet,
               creatorId: creator.id,
            },
         },
         update: {
            balance:
               side === 'buy' ? { increment: qtyDec } : { decrement: qtyDec },
            lastBuyAt: side === 'buy' ? new Date() : undefined,
         },
         create: {
            ownerAddress: wallet,
            creatorId: creator.id,
            balance: side === 'buy' ? qtyDec : new Prisma.Decimal(0),
            lastBuyAt: side === 'buy' ? new Date() : undefined,
         },
      });

      if (side === 'buy') {
         await prisma.creatorProfile.update({
            where: { id: creator.id },
            data: { circulatingSupply: { increment: qtyDec } },
         });
      } else {
         await prisma.creatorProfile.update({
            where: { id: creator.id },
            data: { circulatingSupply: { decrement: qtyDec } },
         });
      }

      sendSuccess(
         res,
         {
            orderId: trade.id,
            tradeId: trade.id,
            keyId: creator.id,
            buyer: wallet,
            quantity: qtyStr,
            price: priceStr,
            side,
            txHash: trade.txHash,
            createdAt: trade.createdAt,
         },
         201,
         'Order created successfully'
      );
   } catch (error) {
      next(error);
   }
}
