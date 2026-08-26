// src/modules/holdings/holdings.routes.ts
// Route wiring for per-wallet holdings.

import { Router } from 'express';
import { requireWalletAuth } from '../../middlewares/auth-wallet.middleware';
import { httpGetHoldings } from './holdings.controller';

const holdingsRouter = Router();

/**
 * GET /users/:wallet/holdings
 *
 * Returns the wallet's key holdings including last_buy_timestamp and
 * lockup_expires_at, sorted by current value descending. Requires a JWT whose
 * wallet matches the path param (401 otherwise).
 */
holdingsRouter.get(
   '/users/:wallet/holdings',
   requireWalletAuth,
   httpGetHoldings
);

export default holdingsRouter;
