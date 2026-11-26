// src/modules/protocol/protocol-escape.routes.ts
import { Router } from 'express';
import {
   sendSuccess,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import { StellarAddressSchema } from '../wallet/wallet.schemas';
import {
   getProtocolEscapeStatus,
   getWalletEscapeHoldings,
} from './protocol-escape.service';

/** GET /protocol/escape: pause state and when escape opens. */
export const protocolEscapeRouter = Router();

protocolEscapeRouter.get('/escape', async (_req, res, next) => {
   try {
      sendSuccess(res, await getProtocolEscapeStatus());
   } catch (error) {
      next(error);
   }
});

/** GET /wallets/:address/escape: per-key recoverable estimates for a wallet. */
export const walletEscapeRouter = Router();

walletEscapeRouter.get('/:address/escape', async (req, res, next) => {
   const parsed = StellarAddressSchema.safeParse(req.params.address);
   if (!parsed.success) {
      sendValidationError(
         res,
         'Invalid wallet address',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }

   try {
      sendSuccess(res, await getWalletEscapeHoldings(parsed.data));
   } catch (error) {
      next(error);
   }
});
