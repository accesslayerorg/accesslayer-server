// src/modules/invoice/invoice.routes.ts
import { Router } from 'express';
import { cacheControl } from '../../middlewares/cache-control.middleware';
import { INVOICE_COMPARISON_CACHE_TTL_SECONDS } from './invoice.schemas';
import { httpGetInvoiceComparison } from './invoice.controllers';
import { invoiceProtocolRouter } from './invoice-protocol.routes';
import { invoiceMarketRouter } from './invoice-market.routes';
import { invoiceEarlyIncentiveRouter } from './invoice-early-incentive.routes';

const invoiceRouter = Router();

/**
 * GET /invoices/compare?ids=<idA>,<idB>
 *
 * Compare metrics for up to two invoices in a single request. Metrics are
 * grouped by invoice ID and cached for 30 seconds per ID combination.
 */
invoiceRouter.get(
   '/compare',
   cacheControl({
      maxAge: INVOICE_COMPARISON_CACHE_TTL_SECONDS,
      type: 'public',
   }),
   httpGetInvoiceComparison
);

invoiceRouter.use(invoiceProtocolRouter);
invoiceRouter.use(invoiceMarketRouter);
invoiceRouter.use(invoiceEarlyIncentiveRouter);

export default invoiceRouter;
