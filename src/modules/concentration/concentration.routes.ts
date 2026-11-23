import { Router } from 'express';
import { z } from 'zod';
import { sendNotFound, sendSuccess, sendValidationError, zodIssuesToDetails } from '../../utils/api-response.utils';
import { ConcentrationKeyNotFoundError, ConcentrationService } from './concentration.service';

const keyParamsSchema = z.object({ keyId: z.string().trim().min(1).max(256) });
const querySchema = z.object({
   includeContracts: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
}).strict();
const router = Router();

router.get('/:keyId/concentration', async (req, res, next) => {
   const key = keyParamsSchema.safeParse(req.params);
   if (!key.success) {
      sendValidationError(res, 'Invalid key identifier', zodIssuesToDetails(key.error.issues));
      return;
   }
   const parsed = querySchema.safeParse(req.query);
   if (!parsed.success) {
      sendValidationError(res, 'Invalid concentration query', zodIssuesToDetails(parsed.error.issues));
      return;
   }
   try {
      sendSuccess(res, await ConcentrationService.compute(key.data.keyId, parsed.data.includeContracts));
   } catch (error) {
      if (error instanceof ConcentrationKeyNotFoundError) {
         sendNotFound(res, 'Key');
         return;
      }
      next(error);
   }
});

export default router;
