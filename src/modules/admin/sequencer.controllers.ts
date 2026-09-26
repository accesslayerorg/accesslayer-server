import { AsyncController } from '../../types/auth.types';
import { clearDrift } from '../../utils/supply-drift-guard.utils';
import {
   sendSuccess,
   sendValidationError,
} from '../../utils/api-response.utils';

export const httpClearDrift: AsyncController = async (req, res, next) => {
   try {
      const rawParam = req.params.creatorWallet;
      const creatorWallet = Array.isArray(rawParam) ? rawParam[0] : rawParam;
      if (!creatorWallet) {
         sendValidationError(res, 'Missing creatorWallet parameter');
         return;
      }

      await clearDrift(creatorWallet);

      sendSuccess(res, {
         creatorWallet,
         status: 'cleared',
         message: `Supply drift flag cleared for ${creatorWallet}`,
      });
   } catch (err) {
      next(err);
   }
};
