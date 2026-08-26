// src/modules/referrals/referrals.controller.ts
// GET /users/:wallet/referrals - referral earnings for a wallet.

import { AsyncController } from '../../types/auth.types';
import { requireWalletAuth } from '../../middlewares/auth-wallet.middleware';
import { sendUnauthorized, sendSuccess } from '../../utils/api-response.utils';
import { getReferralBreakdown, getReferralSummary } from './referrals.service';
import {
   getCachedReferralSummary,
   setCachedReferralSummary,
} from './referrals.cache';

export const httpGetReferrals: AsyncController = async (req, res, next) => {
   try {
      const { wallet } = req.params;
      const authWallet = (req as { authWallet?: string }).authWallet;

      if (!wallet) {
         return sendUnauthorized(res, 'Wallet parameter is required');
      }

      if (!authWallet || authWallet !== wallet) {
         return sendUnauthorized(
            res,
            'You can only view referral earnings for your own wallet'
         );
      }

      const limitParam = req.query.limit;
      const limit =
         typeof limitParam === 'string' ? Number(limitParam) : undefined;
      const cursor =
         typeof req.query.cursor === 'string' ? req.query.cursor : undefined;

      const cachedSummary = await getCachedReferralSummary(wallet);
      const summary = cachedSummary ?? (await getReferralSummary(wallet));
      if (!cachedSummary) {
         await setCachedReferralSummary(wallet, summary);
      }

      const breakdown = await getReferralBreakdown(wallet, {
         cursor,
         limit,
      });

      return sendSuccess(res, {
         ...summary,
         breakdown: breakdown.items,
         nextCursor: breakdown.nextCursor,
         hasNextPage: breakdown.hasNextPage,
      });
   } catch (error) {
      next(error);
   }
};

export { requireWalletAuth };
