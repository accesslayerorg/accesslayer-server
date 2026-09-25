import { Router } from 'express';
import { httpGetWalletActivity } from './wallet-activity.controllers';
import { httpGetWalletHoldings } from './wallet-holdings.controllers';
import { httpGetWalletFollowing } from './wallet-following.controllers';
import { cacheControl } from '../../middlewares/cache-control.middleware';
import { ACTIVITY_FEED_CACHE_PRESET } from '../../constants/activity-feed-cache.constants';
import { requireWalletParamMatch } from '../../middlewares/jwt-auth.middleware';
import { jwtAuth } from '../../middlewares/jwt.middleware';

const walletsRouter = Router();

/**
 * GET /api/v1/wallets/:address/activity
 *
 * Returns the unified chronological on-chain activity feed for a wallet
 * across buys, sells, transfers, burns, and dividends.
 * Requires a valid JWT matching the address parameter.
 */
walletsRouter.get(
   '/:address/activity',
   requireWalletParamMatch('address'),
   cacheControl(ACTIVITY_FEED_CACHE_PRESET),
   httpGetWalletActivity
);

/**
 * GET /api/v1/wallets/:address/holdings
 *
 * Returns all creator key holdings for a given Stellar wallet address.
 */
walletsRouter.get('/:address/holdings', httpGetWalletHoldings);

/**
 * GET /api/v1/wallets/:address/following
 *
 * Returns all creators that the given wallet follows, ordered
 * alphabetically by display name. Requires JWT authentication.
 */
walletsRouter.get('/:address/following', jwtAuth, httpGetWalletFollowing);

export default walletsRouter;
