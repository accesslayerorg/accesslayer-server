// src/modules/holdings/holdings.controller.ts
// GET /users/:wallet/holdings - portfolio holdings for a wallet.

import { AsyncController } from '../../types/auth.types';
import { requireWalletAuth } from '../../middlewares/auth-wallet.middleware';
import { sendUnauthorized, sendSuccess } from '../../utils/api-response.utils';
import { getHoldings } from './holdings.service';

export const httpGetHoldings: AsyncController = async (req, res, next) => {
   try {
      const { wallet } = req.params;
      const authWallet = (req as { authWallet?: string }).authWallet;

      if (!wallet) {
         return sendUnauthorized(res, 'Wallet parameter is required');
      }

      if (!authWallet || authWallet !== wallet) {
         return sendUnauthorized(
            res,
            'You can only view holdings for your own wallet'
         );
      }

      const holdings = await getHoldings(wallet);
      return sendSuccess(res, holdings);
   } catch (error) {
      next(error);
   }
};

export { requireWalletAuth };
