import { Router } from 'express';
import { z } from 'zod';
import {
   AuthenticatedRequest,
   requireJwtAuth,
} from '../../middlewares/jwt-auth.middleware';
import { sendSuccess } from '../../utils/api-response.utils';
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
