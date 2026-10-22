import { Router } from 'express';
import {
   httpGetWalletBundleTrades,
   httpGetWalletTrades,
} from './trades.controllers';

const tradesRouter = Router();

/**
 * GET /trades/:wallet/bundles
 *
 * Paginated bundle trade history with per-item breakdown.
 * Returns timestamp, total_cost, item count, and per-item key/amount/price.
 */
tradesRouter.get('/:wallet/bundles', httpGetWalletBundleTrades);

/**
 * GET /trades/:wallet
 *
 * Standard paginated trade history.
 * Single trades have type: 'single', bundle trades have type: 'bundle'.
 */
tradesRouter.get('/:wallet', httpGetWalletTrades);

export default tradesRouter;
