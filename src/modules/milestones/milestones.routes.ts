import { Router } from 'express';
import { sendSuccess } from '../../utils/api-response.utils';
import { logger } from '../../utils/logger.utils';
import { getWalletAllMilestones } from './holder-milestones.service';

const router = Router();

/**
 * GET /milestones/:wallet
 * Returns milestone status across all held keys for a wallet (#1115).
 */
router.get('/:wallet', async (req, res, next) => {
   const wallet = String(req.params.wallet);
   try {
      const result = await getWalletAllMilestones(wallet);
      sendSuccess(res, result);
   } catch (error) {
      logger.error({ error, wallet }, 'Get all wallet milestones failed');
      next(error);
   }
});

export default router;
