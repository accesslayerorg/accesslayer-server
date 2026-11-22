import { Router } from 'express';
import {
   sendSuccess,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import {
   scheduledTransferParamsSchema,
   scheduledTransferQuerySchema,
} from './scheduled-transfer.schemas';
import {
   listScheduledTransfers,
   ScheduledTransferCursorError,
} from './scheduled-transfer.service';

const scheduledTransferRouter = Router();

// Mounted under /wallets by the API module registry.
scheduledTransferRouter.get('/:address/scheduled-transfers', async (req, res, next) => {
   const params = scheduledTransferParamsSchema.safeParse(req.params);
   const query = scheduledTransferQuerySchema.safeParse(req.query);
   if (!params.success) {
      sendValidationError(res, 'Invalid wallet address', zodIssuesToDetails(params.error.issues));
      return;
   }
   if (!query.success) {
      sendValidationError(res, 'Invalid query parameters', zodIssuesToDetails(query.error.issues));
      return;
   }
   try {
      sendSuccess(res, await listScheduledTransfers(params.data.address, query.data));
   } catch (error) {
      if (error instanceof ScheduledTransferCursorError) {
         sendValidationError(res, error.message);
         return;
      }
      next(error);
   }
});

export default scheduledTransferRouter;
