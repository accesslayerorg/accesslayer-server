// src/modules/invoice/invoice-early-incentive.routes.ts
// GET /invoices/:invoice_id/early-incentive (#1180). Public read; mounted on
// invoiceRouter.

import { Router } from 'express';
import { z } from 'zod';
import {
   sendNotFound,
   sendSuccess,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import { getEarlyIncentiveStatus } from './invoice-early-incentive.service';

export const invoiceEarlyIncentiveRouter = Router();

const paramsSchema = z.object({
   invoice_id: z.string().min(1).max(128),
});

invoiceEarlyIncentiveRouter.get(
   '/:invoice_id/early-incentive',
   async (req, res, next) => {
      const params = paramsSchema.safeParse(req.params);
      if (!params.success) {
         sendValidationError(
            res,
            'Invalid invoice id',
            zodIssuesToDetails(params.error.issues)
         );
         return;
      }
      try {
         const status = await getEarlyIncentiveStatus(params.data.invoice_id);
         if (!status) {
            sendNotFound(res, 'Invoice');
            return;
         }
         sendSuccess(res, status);
      } catch (error) {
         next(error);
      }
   }
);
