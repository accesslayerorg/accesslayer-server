import { Router } from 'express';
import { z } from 'zod';
import { getKeyBackstops, getPolSummary } from './pol.service';
import { sendSuccess, sendValidationError, zodIssuesToDetails } from '../../utils/api-response.utils';

export const protocolPolRouter = Router();
export const keyBackstopsRouter = Router();
const keySchema = z.string().trim().min(1).max(128);
const paginationSchema = z.object({
   limit: z.string().regex(/^[1-9][0-9]*$/).transform(Number).pipe(z.number().int().max(100)).optional().default('25'),
   offset: z.string().regex(/^(0|[1-9][0-9]*)$/).transform(Number).pipe(z.number().int().max(1000000)).optional().default('0'),
});
protocolPolRouter.get('/pol', async (_req, res, next) => {
   try { sendSuccess(res, await getPolSummary()); } catch (error) { next(error); }
});
keyBackstopsRouter.get('/:keyId/backstops', async (req, res, next) => {
   const key = keySchema.safeParse(req.params.keyId);
   const query = paginationSchema.safeParse(req.query);
   if (!key.success || !query.success) {
      const issues = !key.success ? key.error.issues : !query.success ? query.error.issues : [];
      sendValidationError(res, 'Invalid backstop query', zodIssuesToDetails(issues));
      return;
   }
   try {
      sendSuccess(res, await getKeyBackstops(key.data, query.data.limit, query.data.offset));
   } catch (error) { next(error); }
});
