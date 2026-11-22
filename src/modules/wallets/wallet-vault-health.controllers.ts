import { Request, Response, NextFunction } from 'express';
import { StrKey } from '@stellar/stellar-base';
import {
   ErrorCode,
   sendError,
   sendNotFound,
   sendSuccess,
   sendValidationError,
} from '../../utils/api-response.utils';
import {
   getWalletVaultHealth,
   VaultHealthUnavailableError,
} from '../vault/vault-health.service';

export async function httpGetWalletVaultHealth(
   req: Request,
   res: Response,
   next: NextFunction
): Promise<void> {
   const address = String(req.params.address);
   if (!StrKey.isValidEd25519PublicKey(address)) {
      sendValidationError(res, 'Invalid wallet address', [
         { field: 'address', message: 'Invalid Stellar wallet' },
      ]);
      return;
   }

   try {
      const health = await getWalletVaultHealth(address);
      if (!health) {
         sendNotFound(res, 'Vault position');
         return;
      }
      res.setHeader('Cache-Control', 'no-store');
      sendSuccess(res, health);
   } catch (error) {
      if (error instanceof VaultHealthUnavailableError) {
         sendError(res, 503, ErrorCode.SERVICE_UNAVAILABLE, error.message);
         return;
      }
      next(error);
   }
}
