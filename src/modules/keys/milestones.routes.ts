import { Router } from 'express';
import { sendSuccess } from '../../utils/api-response.utils';
import { getWalletMilestones } from './holder-milestones.service';

const router = Router();
router.get('/:wallet', async (req, res, next) => {
   try {
      sendSuccess(res, await getWalletMilestones(String(req.params.wallet)));
   } catch (error) {
      next(error);
   }
});
export default router;
