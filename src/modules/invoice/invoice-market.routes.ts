import { Router } from 'express';
import { z } from 'zod';
import {
   AuthenticatedRequest,
   requireJwtAuth,
} from '../../middlewares/jwt-auth.middleware';
import { sendSuccess } from '../../utils/api-response.utils';
import { prisma } from '../../utils/prisma.utils';
import { cacheControl } from '../../middlewares/cache-control.middleware';
import { protocolHandler } from './invoice-protocol.routes';
import {
   buyInvoice,
   placeInvoiceLimitOrder,
   matchInvoiceLimitOrders,
} from './invoice-market.service';

const body = z
   .object({ transaction_xdr: z.string().min(1).max(100000) })
   .strict();
export const invoiceMarketRouter = Router();
const priceLimit = z.coerce.number().int().min(1).max(100).default(50);

invoiceMarketRouter.get('/:invoice_id/secondary-prices', cacheControl({ maxAge: 30, type: 'public' }), async (req, res, next) => {
   try {
      const limit = priceLimit.parse(req.query.limit);
      const items = await prisma.invoiceSecondaryTradePrice.findMany({ where: { invoiceId: String(req.params.invoice_id) }, orderBy: { tradedAt: 'desc' }, take: limit, select: { price: true, amount: true, tradedAt: true, txHash: true } });
      sendSuccess(res, { items });
   } catch (error) { next(error); }
});

invoiceMarketRouter.get('/:invoice_id/secondary-prices/last', cacheControl({ maxAge: 30, type: 'public' }), async (req, res, next) => {
   try {
      const item = await prisma.invoiceSecondaryTradePrice.findFirst({ where: { invoiceId: String(req.params.invoice_id) }, orderBy: { tradedAt: 'desc' }, select: { price: true, amount: true, tradedAt: true, txHash: true } });
      sendSuccess(res, { item });
   } catch (error) { next(error); }
});
invoiceMarketRouter.post(
   '/:invoice_id/buy',
   requireJwtAuth,
   protocolHandler(async (req: AuthenticatedRequest, res) => {
      const input = body.parse(req.body);
      sendSuccess(
         res,
         await buyInvoice(
            String(req.params.invoice_id),
            req.user!.wallet,
            input.transaction_xdr
         )
      );
   })
);
invoiceMarketRouter.post(
   '/:invoice_id/limit-orders',
   requireJwtAuth,
   protocolHandler(async (req: AuthenticatedRequest, res) => {
      const input = body.parse(req.body);
      sendSuccess(
         res,
         await placeInvoiceLimitOrder(
            String(req.params.invoice_id),
            req.user!.wallet,
            input.transaction_xdr
         ),
         201
      );
   })
);
invoiceMarketRouter.post(
   '/:invoice_id/limit-orders/match',
   requireJwtAuth,
   protocolHandler(async (req: AuthenticatedRequest, res) => {
      sendSuccess(
         res,
         await matchInvoiceLimitOrders(
            String(req.params.invoice_id),
            req.user!.wallet
         )
      );
   })
);
