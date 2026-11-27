import { Router } from 'express';
import { z } from 'zod';
import { sendNotFound, sendSuccess, sendValidationError, zodIssuesToDetails } from '../../utils/api-response.utils';
import { getRoyaltyEnforcement, RoyaltyKeyNotFoundError } from './marketplace.service';

const keyParamsSchema = z.object({ keyId: z.string().trim().min(1).max(256) });
const router = Router();
router.get('/:keyId/royalty-enforcement', async (req, res, next) => {
   const key = keyParamsSchema.safeParse(req.params);
   if (!key.success) {
      sendValidationError(res, 'Invalid key identifier', zodIssuesToDetails(key.error.issues));
      return;
   }
   try {
      sendSuccess(res, await getRoyaltyEnforcement(key.data.keyId));
   } catch (error) {
      if (error instanceof RoyaltyKeyNotFoundError) {
         sendNotFound(res, 'Key');
         return;
      }
      next(error);
   }
});
export default router;
