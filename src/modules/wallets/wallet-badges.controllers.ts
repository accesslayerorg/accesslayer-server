import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { StellarAddressSchema } from '../wallet/wallet.schemas';
import {
   getWalletBadgeCollection,
   getWalletBadgeSummary,
} from '../badges/badge-read.service';
import {
   sendSuccess,
   sendValidationError,
} from '../../utils/api-response.utils';

const WalletBadgesParamsSchema = z.object({
   wallet: StellarAddressSchema,
});

async function parseWallet(
   req: Request,
   res: Response
): Promise<string | null> {
   const parsed = WalletBadgesParamsSchema.safeParse(req.params);
   if (parsed.success) return parsed.data.wallet;

   sendValidationError(
      res,
      'Invalid wallet address',
      parsed.error.issues.map(issue => ({
         field: 'wallet',
         message: issue.message,
      }))
   );
   return null;
}

export async function httpGetWalletBadges(
   req: Request,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const wallet = await parseWallet(req, res);
      if (!wallet) return;
      sendSuccess(res, await getWalletBadgeCollection(wallet));
   } catch (error) {
      next(error);
   }
}

export async function httpGetWalletBadgeSummary(
   req: Request,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const wallet = await parseWallet(req, res);
      if (!wallet) return;
      sendSuccess(res, await getWalletBadgeSummary(wallet));
   } catch (error) {
      next(error);
   }
}
