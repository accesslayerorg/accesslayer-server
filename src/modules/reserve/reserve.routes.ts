import { Router } from 'express';
import { z } from 'zod';
import { sendSuccess, sendValidationError, zodIssuesToDetails } from '../../utils/api-response.utils';
import { getReserveBalance, getReserveHistory } from '../indexer/reserve-indexer.service';

const router = Router();
const pagination = z.object({
   limit: z.coerce.number().int().min(1).max(100).default(50),
   offset: z.coerce.number().int().min(0).default(0),
});

router.get('/:asset/balance', async (req, res, next) => {
   try { sendSuccess(res, await getReserveBalance(req.params.asset)); }
   catch (error) { next(error); }
});

router.get('/:asset/history', async (req, res, next) => {
   const parsed = pagination.safeParse(req.query);
   if (!parsed.success) {
      sendValidationError(res, 'Invalid pagination parameters', zodIssuesToDetails(parsed.error.issues));
      return;
   }
   try {
      const items = await getReserveHistory(req.params.asset, parsed.data.limit, parsed.data.offset);
      sendSuccess(res, { items, ...parsed.data });
   } catch (error) { next(error); }
});

export default router;
