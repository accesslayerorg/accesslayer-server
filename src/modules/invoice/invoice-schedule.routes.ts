// src/modules/invoice/invoice-schedule.routes.ts
// GET /invoices/:invoice_id/schedule and GET /invoices/:invoice_id/schedule/next (#1177).

import { Router } from 'express';
import { z } from 'zod';
import { cacheControl } from '../../middlewares/cache-control.middleware';
import {
   sendNotFound,
   sendSuccess,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import {
   getInvoiceSchedule,
   getNextInvoiceInstalment,
   INVOICE_SCHEDULE_CACHE_TTL_SECONDS,
} from './invoice-schedule.service';

export const invoiceScheduleRouter = Router();

const paramsSchema = z.object({
   invoice_id: z.string().min(1).max(128),
});

const scheduleCache = () =>
   cacheControl({
      maxAge: INVOICE_SCHEDULE_CACHE_TTL_SECONDS,
      type: 'public',
      mustRevalidate: true,
   });

invoiceScheduleRouter.get(
   '/:invoice_id/schedule/next',
   scheduleCache(),
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
         const nextInstalment = await getNextInvoiceInstalment(
            params.data.invoice_id
         );
         if (!nextInstalment) {
            sendNotFound(res, 'Invoice');
            return;
         }
         sendSuccess(res, nextInstalment);
      } catch (error) {
         next(error);
      }
   }
);

invoiceScheduleRouter.get(
   '/:invoice_id/schedule',
   scheduleCache(),
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
         const schedule = await getInvoiceSchedule(params.data.invoice_id);
         if (!schedule) {
            sendNotFound(res, 'Invoice');
            return;
         }
         sendSuccess(res, schedule);
      } catch (error) {
         next(error);
      }
   }
);
