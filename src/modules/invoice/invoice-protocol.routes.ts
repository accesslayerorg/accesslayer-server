import { Router, RequestHandler } from 'express';
import { StrKey } from '@stellar/stellar-base';
import { z } from 'zod';
import {
   ErrorCode,
   sendError,
   sendNotFound,
   sendSuccess,
   sendPaginatedSuccess,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import {
   InvoiceProtocolUnavailableError,
   TransferBlockedError,
} from './invoice-protocol.contract';
import { InvalidInvoiceTransactionError } from './invoice-market.service';
import { ContractSubmitError } from '../contracts/contract-error.utils';
import {
   InvoiceProtocolNotFoundError,
   ProtocolPage,
   invoiceDetail,
   invoiceReport,
   invoiceReports,
   issuerHistory,
   issuerReputation,
   timelockDetail,
   timelockList,
   transferAudit,
} from './invoice-protocol.service';

const pageSchema = z.object({
   page: z.coerce.number().int().min(1).max(100000).default(1),
   limit: z.coerce.number().int().min(1).max(100).default(20),
});
const walletSchema = z
   .string()
   .refine(StrKey.isValidEd25519PublicKey, 'Invalid Stellar wallet');

export const protocolHandler =
   (handler: RequestHandler): RequestHandler =>
   async (req, res, next) => {
      try {
         await handler(req, res, next);
      } catch (error) {
         if (error instanceof InvoiceProtocolNotFoundError)
            return sendNotFound(res, error.message);
         if (error instanceof InvalidInvoiceTransactionError)
            return sendError(res, 400, ErrorCode.BAD_REQUEST, error.message);
         if (error instanceof ContractSubmitError)
            return sendError(
               res,
               error.kind === 'user' ? 400 : 503,
               error.kind === 'user'
                  ? ErrorCode.BAD_REQUEST
                  : ErrorCode.SERVICE_UNAVAILABLE,
               error.message
            );
         if (error instanceof InvoiceProtocolUnavailableError)
            return sendError(
               res,
               503,
               ErrorCode.SERVICE_UNAVAILABLE,
               error.message
            );
         if (error instanceof TransferBlockedError)
            return sendError(
               res,
               403,
               ErrorCode.TRANSFER_BLOCKED,
               error.reason,
               [
                  { field: 'reason', message: error.reason },
                  { field: 'restriction_type', message: error.restrictionType },
               ]
            );
         if (error instanceof z.ZodError)
            return sendValidationError(
               res,
               'Invalid request',
               zodIssuesToDetails(error.issues)
            );
         next(error);
      }
   };
const list = (
   handler: (
      req: Parameters<RequestHandler>[0],
      page: ProtocolPage
   ) => Promise<{
      data: unknown[];
      meta: ReturnType<typeof import('./invoice-protocol.service').pagination>;
   }>
): RequestHandler =>
   protocolHandler(async (req, res) => {
      const result = await handler(req, pageSchema.parse(req.query));
      sendPaginatedSuccess(res, result.data, result.meta);
   });

export const issuerRouter = Router();
issuerRouter.get(
   '/:wallet/reputation/history',
   list((req, page) =>
      issuerHistory(walletSchema.parse(req.params.wallet), page)
   )
);
issuerRouter.get(
   '/:wallet/reputation',
   protocolHandler(async (req, res) => {
      sendSuccess(
         res,
         await issuerReputation(walletSchema.parse(req.params.wallet))
      );
   })
);

export const timelockRouter = Router();
// Countdown values must never be served from an HTTP response cache.
timelockRouter.use((_req, res, next) => {
   res.setHeader('Cache-Control', 'no-store');
   next();
});
timelockRouter.get(
   '/pending',
   list((_req, page) => timelockList(true, page))
);
timelockRouter.get(
   '/history',
   list((_req, page) => timelockList(false, page))
);
timelockRouter.get(
   '/:proposal_id',
   protocolHandler(async (req, res) => {
      sendSuccess(res, await timelockDetail(String(req.params.proposal_id)));
   })
);

export const invoiceProtocolRouter = Router();
invoiceProtocolRouter.get(
   '/:invoice_id/reports',
   list((req, page) => invoiceReports(String(req.params.invoice_id), page))
);
invoiceProtocolRouter.get(
   '/:invoice_id/reports/:report_id',
   protocolHandler(async (req, res) => {
      sendSuccess(
         res,
         await invoiceReport(
            String(req.params.invoice_id),
            String(req.params.report_id)
         )
      );
   })
);
invoiceProtocolRouter.get(
   '/:invoice_id/transfer-audit',
   list((req, page) => transferAudit(String(req.params.invoice_id), page))
);
invoiceProtocolRouter.get(
   '/:invoice_id',
   protocolHandler(async (req, res) => {
      sendSuccess(res, await invoiceDetail(String(req.params.invoice_id)));
   })
);
