import { Router } from 'express';
import { httpGetWalletHoldings } from './wallet.controllers';

/**
 * Routes mounted by `modules/index.ts` under `/wallets`.
 */
const walletRouter = Router();

/**
 * GET /api/v1/wallets/:address/holdings
 *
 * Public lookup of the creator-key holdings owned by a Stellar wallet.
 * Zero-balance entries are excluded server-side.
 */
walletRouter.get('/:address/holdings', httpGetWalletHoldings);

export default walletRouter;
