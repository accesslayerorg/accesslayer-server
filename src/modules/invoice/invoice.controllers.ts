// src/modules/invoice/invoice.controllers.ts
import { AsyncController } from '../../types/auth.types';
import {
   sendNotFound,
   sendSuccess,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import {
   InvoiceComparisonQuerySchema,
   MAX_COMPARABLE_INVOICES,
   parseInvoiceIds,
} from './invoice.schemas';
import { getInvoiceComparison, InvoiceNotFoundError } from './invoice.service';

/**
 * GET /invoices/compare?ids=<idA>,<idB>
 *
 * Returns comparison metrics for up to {@link MAX_COMPARABLE_INVOICES}
 * invoices, grouped by invoice ID. Responses are served from the 30s
 * comparison cache keyed by the requested ID combination.
 */
export const httpGetInvoiceComparison: AsyncController = async (
   req,
   res,
   next
) => {
   const parsed = InvoiceComparisonQuerySchema.safeParse(req.query);
   if (!parsed.success) {
      return sendValidationError(
         res,
         'Invalid query parameters',
         zodIssuesToDetails(parsed.error.issues)
      );
   }

   const ids = parseInvoiceIds(parsed.data.ids);

   if (ids.length === 0) {
      return sendValidationError(res, 'Invalid query parameters', [
         { field: 'ids', message: 'At least one invoice ID is required' },
      ]);
   }

   if (ids.length > MAX_COMPARABLE_INVOICES) {
      return sendValidationError(
         res,
         `Maximum ${MAX_COMPARABLE_INVOICES} invoice IDs allowed`,
         [
            {
               field: 'ids',
               message: `Maximum ${MAX_COMPARABLE_INVOICES} invoice IDs allowed, received ${ids.length}`,
            },
         ]
      );
   }

   try {
      const comparison = await getInvoiceComparison(ids);
      return sendSuccess(res, comparison);
   } catch (error) {
      if (error instanceof InvoiceNotFoundError) {
         return sendNotFound(res, 'Invoice');
      }
      return next(error);
   }
};
