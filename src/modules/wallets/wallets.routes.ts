import { Router } from 'express';
import { httpGetWalletActivity } from './wallet-activity.controllers';
import { httpGetWalletHoldings } from './wallet-holdings.controllers';
import { cacheControl } from '../../middlewares/cache-control.middleware';
import { ACTIVITY_FEED_CACHE_PRESET } from '../../constants/activity-feed-cache.constants';

const walletsRouter = Router();

/**
 * GET /api/v1/wallets/:address/activity
 *
 * Returns the paginated trade history (buys and sells) for a given Stellar
 * wallet address across all creators. Supports optional `type` (buy|sell)
 * and `creator_id` filters.
 */
walletsRouter.get(
    '/:address/activity',
    cacheControl(ACTIVITY_FEED_CACHE_PRESET),
    httpGetWalletActivity
);

/**
 * GET /api/v1/wallets/:address/holdings
 *
 * Returns all creator key holdings for a given Stellar wallet address,
 * including creator handle, key count, and latest known price.
 */
walletsRouter.get('/:address/holdings', httpGetWalletHoldings);

export default walletsRouter;
