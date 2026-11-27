import { Router } from 'express';
import { z } from 'zod';
import {
   sendNotFound,
   sendSuccess,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import {
   CommitRevealLaunchService,
   LaunchWindowNotFoundError,
} from './commit-reveal-launch.service';

const keyParamsSchema = z.object({
   keyId: z.string().trim().min(1).max(256),
});

const walletQuerySchema = z.object({
   wallet: z.string().trim().min(1).max(128),
});

const router = Router();

/**
 * GET /v1/keys/:keyId/launch
 * Returns current commit-reveal launch phase, ledgers remaining, and aggregate counts.
 */
router.get('/:keyId/launch', async (req, res, next) => {
   const params = keyParamsSchema.safeParse(req.params);
   if (!params.success) {
      sendValidationError(
         res,
         'Invalid key identifier',
         zodIssuesToDetails(params.error.issues)
      );
      return;
   }

   try {
      const status = await CommitRevealLaunchService.getStatus(
         params.data.keyId
      );
      sendSuccess(res, status, 200, 'Launch status retrieved');
   } catch (error) {
      if (error instanceof LaunchWindowNotFoundError) {
         sendNotFound(res, 'Launch window');
         return;
      }
      next(error);
   }
});

/**
 * GET /v1/keys/:keyId/launch/me?wallet=
 * Returns the wallet's commit, reveal, and fill status.
 */
router.get('/:keyId/launch/me', async (req, res, next) => {
   const params = keyParamsSchema.safeParse(req.params);
   if (!params.success) {
      sendValidationError(
         res,
         'Invalid key identifier',
         zodIssuesToDetails(params.error.issues)
      );
      return;
   }

   const query = walletQuerySchema.safeParse(req.query);
   if (!query.success) {
      sendValidationError(
         res,
         'Invalid wallet query parameter',
         zodIssuesToDetails(query.error.issues)
      );
      return;
   }

   try {
      const status = await CommitRevealLaunchService.getWalletStatus(
         params.data.keyId,
         query.data.wallet
      );
      sendSuccess(res, status, 200, 'Wallet launch status retrieved');
   } catch (error) {
      if (error instanceof LaunchWindowNotFoundError) {
         sendNotFound(res, 'Launch window');
         return;
      }
      next(error);
   }
});

export default router;
