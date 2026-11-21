// src/modules/wallets/wallet-following.controllers.ts
import { Request, Response, NextFunction } from 'express';
import { WalletFollowingParamsSchema } from './wallet-following.schemas';
import { fetchWalletFollowing } from './wallet-following.service';
import { sendSuccess, sendValidationError } from '../../utils/api-response.utils';

export async function httpGetWalletFollowing(
   req: Request,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const parsedParams = WalletFollowingParamsSchema.safeParse(req.params);
      if (!parsedParams.success) {
         sendValidationError(
            res,
            'Invalid wallet address',
            parsedParams.error.issues.map(
               (issue: { path: (string | number)[]; message: string }) => ({
                  field: 'address',
                  message: issue.message,
               })
            )
         );
         return;
      }

      const creators = await fetchWalletFollowing(parsedParams.data.address);

      sendSuccess(res, creators);
   } catch (error) {
      next(error);
   }
}
