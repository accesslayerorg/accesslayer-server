import { Router } from 'express';
import { sendSuccess } from '../../utils/api-response.utils';
import { getApprovedMarketplaces } from './marketplace.service';

const router = Router();
router.get('/', async (_req, res, next) => {
   try {
      sendSuccess(res, await getApprovedMarketplaces());
   } catch (error) {
      next(error);
   }
});
export default router;
