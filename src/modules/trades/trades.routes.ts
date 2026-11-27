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
 *
 * Flagged trades (isFlagged = true) are excluded from the returned history
 * only when the caller does not request them via the admin API; wash-trade
 * flags are reviewed through GET /v1/admin/trade-flags.
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
