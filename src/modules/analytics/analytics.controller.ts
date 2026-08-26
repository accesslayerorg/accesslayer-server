// src/modules/analytics/analytics.controller.ts
// GET /creator/:keyId/analytics — daily key performance for the creator.

import { AsyncController } from '../../types/auth.types';
import { requireWalletAuth } from '../../middlewares/auth-wallet.middleware';
import { sendForbidden, sendSuccess } from '../../utils/api-response.utils';
import {
   getCreatorKeyWallet,
   getKeyAnalytics,
} from './analytics.service';
import {
   getCachedAnalytics,
   setCachedAnalytics,
} from './analytics.cache';

export const httpGetKeyAnalytics: AsyncController = async (req, res, next) => {
   try {
      const keyId = String(req.params.keyId ?? '');
      const authWallet = (req as { authWallet?: string }).authWallet;

      if (!keyId) {
         return sendForbidden(res, 'Creator key id is required');
      }

      const creatorWallet = await getCreatorKeyWallet(keyId);
      if (!creatorWallet) {
         // Key does not exist — treat as forbidden to avoid leaking existence.
         return sendForbidden(res, 'You are not authorized to view this key');
      }

      if (!authWallet || authWallet !== creatorWallet) {
         return sendForbidden(
            res,
            'Only the key creator can view analytics for this key'
         );
      }

      const cached = await getCachedAnalytics(keyId);
      if (cached) {
         return sendSuccess(res, cached);
      }

      const analytics = await getKeyAnalytics(keyId);
      await setCachedAnalytics(keyId, analytics);
      return sendSuccess(res, analytics);
   } catch (error) {
      next(error);
   }
};

export { requireWalletAuth };
