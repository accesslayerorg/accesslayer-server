// src/modules/sellers/sellers.routes.ts
import { Router, Response, NextFunction } from 'express';
import {
   requireJwtAuth,
   AuthenticatedRequest,
} from '../../middlewares/jwt-auth.middleware';
import { sendSuccess } from '../../utils/api-response.utils';
import { getSellerOnboardingStatus } from './sellers.service';

const router = Router();

/**
 * GET /sellers/onboarding-status (or /api/v1/sellers/onboarding-status)
 * Returns onboarding checklist completion status for the authenticated seller wallet.
 */
router.get(
   '/onboarding-status',
   requireJwtAuth,
   async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
         const walletAddress = req.user!.wallet;
         const status = await getSellerOnboardingStatus(walletAddress);
         sendSuccess(res, status);
      } catch (error) {
         next(error);
      }
   }
);

export default router;
