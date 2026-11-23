import { Router } from 'express';
import { StrKey } from '@stellar/stellar-base';
import { z } from 'zod';
import { sendSuccess, sendValidationError, zodIssuesToDetails } from '../../utils/api-response.utils';
import { getWalletVotingWeight } from './governance-voting-weight.service';

const router = Router();
const ParamsSchema = z.object({
   wallet: z.string().refine(StrKey.isValidEd25519PublicKey, 'Invalid Stellar wallet'),
   key_id: z.string().trim().min(1).max(128),
});
const QuerySchema = z.object({}).strict();

router.get('/voting-weight/:wallet/:key_id', async (req, res, next) => {
   const params = ParamsSchema.safeParse(req.params);
   const query = QuerySchema.safeParse(req.query);
   if (!params.success || !query.success) {
      const issues = !params.success ? params.error.issues : !query.success ? query.error.issues : [];
      sendValidationError(res, 'Invalid voting weight request', zodIssuesToDetails(issues));
      return;
   }
   try {
      // Redis is invalidated by events; browser/CDN caches cannot be invalidated.
      res.set('Cache-Control', 'no-store');
      sendSuccess(res, await getWalletVotingWeight(params.data.wallet, params.data.key_id));
   } catch (error) {
      next(error);
   }
});

export default router;
