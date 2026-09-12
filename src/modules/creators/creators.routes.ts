import { httpDistributeDividend } from '../dividends/dividend.controllers';
import { requireJwtAuth } from '../../middlewares/jwt-auth.middleware';
import { Router } from 'express';
import { sendNotFound, sendSuccess } from '../../utils/api-response.utils';
import {
   httpListCreators,
   httpGetCreator,
   httpGetCreatorStats,
   httpGetTrendingCreators,
   httpGetCreatorLeaderboard,
   httpGetCreatorAnalytics,
} from './creators.controllers';
import { httpGetCreatorHolders } from './creator-holders.controller';
import { httpGetVolumeLeaderboard } from './creator-leaderboard-volume.controller';
import { cacheControl } from '../../middlewares/cache-control.middleware';
import { CREATOR_PUBLIC_ROUTE_CACHE_PRESETS } from '../../constants/creator-public-cache.constants';
import { CREATOR_PUBLIC_ROUTE_NAMES } from '../../constants/creator-public-routes.constants';
import { createCreatorReadMetricsMiddleware } from '../../utils/creator-read-metrics.utils';
import { normalizeTrailingSlash } from '../../middlewares/trailing-slash-normalizer.middleware';
import { validateCreatorParam } from '../../middlewares/creator-param.middleware';
import { requireCreatorProfileOwnership } from '../../middlewares/wallet-ownership.middleware';
import { requireStellarSignature } from '../../middlewares/stellar-signature.middleware';
import { buyKeyRateLimit } from '../../middlewares/wallet-rate-limit.middleware';
import { validateBody } from '../../middlewares/validate-body.middleware';
import { withIdempotency } from '../../middlewares/idempotency.middleware';
import { httpBuyCreatorKey, buySchema } from '../creator/buy.controller';
import {
   httpCreatePost,
   httpListPosts,
   postSchema,
} from '../creator/post.controller';
import { requireKeyCreator } from '../../middlewares/jwt-auth.middleware';
import {
   getCreatorRevenue,
   KeyNotFoundError as RevenueKeyNotFoundError,
} from '../creator/creator-revenue.service';
import { httpGetCreatorDashboard } from '../creator/creator-dashboard.controller';
import { httpCreateCreatorProposal } from '../creator/creator-proposals.controller';
import { createProposalSchema } from '../creator/creator-proposals.schemas';

const creatorsRouter = Router();

// Normalize trailing slashes for all creator routes so that, e.g.,
// GET /api/v1/creators/ reaches the same handler as GET /api/v1/creators.
// Scoped to this router to avoid side-effects on other route groups.
creatorsRouter.use(normalizeTrailingSlash);

creatorsRouter.post(
   '/:id/buy',
   validateCreatorParam('id'),
   requireStellarSignature(),
   buyKeyRateLimit,
   validateBody(buySchema),
   withIdempotency(httpBuyCreatorKey)
);
creatorsRouter.post('/:id/dividends', requireJwtAuth, httpDistributeDividend);
creatorsRouter.get('/:id/posts', validateCreatorParam('id'), httpListPosts);
creatorsRouter.post(
   '/:id/posts',
   validateCreatorParam('id'),
   requireStellarSignature(),
   validateBody(postSchema),
   httpCreatePost
);

/**
 * GET /api/v1/creators
 *
 * List all creators with pagination and filtering.
 * Public endpoint with 5-minute cache.
 */
creatorsRouter.get(
   '/',
   createCreatorReadMetricsMiddleware('list'),
   cacheControl(
      CREATOR_PUBLIC_ROUTE_CACHE_PRESETS[CREATOR_PUBLIC_ROUTE_NAMES.LIST]
   ),
   httpListCreators
);
// 405 handler for /
creatorsRouter.all('/', (_req, res) => {
   res.set('Allow', 'GET').sendStatus(405);
});

/**
 * GET /api/v1/creators/:id/stats
 *
 * Get public stats for a specific creator.
 * Public endpoint with 5-minute cache.
 */
creatorsRouter.get(
   '/:id/stats',
   validateCreatorParam('id'),
   createCreatorReadMetricsMiddleware('detail'),
   cacheControl(
      CREATOR_PUBLIC_ROUTE_CACHE_PRESETS[CREATOR_PUBLIC_ROUTE_NAMES.GET_STATS]
   ),
   httpGetCreatorStats
);
// 405 handler for /:id/stats
creatorsRouter.all('/:id/stats', (_req, res) => {
   res.set('Allow', 'GET').sendStatus(405);
});

/**
 * GET /api/v1/creators/:id/holders
 *
 * Returns a paginated list of wallets that hold keys for a creator.
 * Supports ?sort=held_since to surface earliest supporters first.
 * Public endpoint with 5-minute cache.
 */
creatorsRouter.get(
   '/:id/holders',
   validateCreatorParam('id'),
   createCreatorReadMetricsMiddleware('holders'),
   cacheControl(
      CREATOR_PUBLIC_ROUTE_CACHE_PRESETS[CREATOR_PUBLIC_ROUTE_NAMES.GET_HOLDERS]
   ),
   httpGetCreatorHolders
);
// 405 handler for /:id/holders
creatorsRouter.all('/:id/holders', (_req, res) => {
   res.set('Allow', 'GET').sendStatus(405);
});

/**
 * GET /api/v1/creators/trending
 *
 * List trending creators ordered by 24h trading volume descending.
 */
creatorsRouter.get(
   '/trending',
   createCreatorReadMetricsMiddleware('list'),
   httpGetTrendingCreators
);

/**
 * GET /api/v1/creators/:id/analytics
 *
 * Returns buy volume and unique buyer count for the authenticated creator.
 * Protected route — requires wallet ownership via x-wallet-address header.
 */
creatorsRouter.get(
   '/:id/analytics',
   validateCreatorParam('id'),
   requireCreatorProfileOwnership('id'),
   httpGetCreatorAnalytics
);
// 405 handler for /:id/analytics
creatorsRouter.all('/:id/analytics', (_req, res) => {
   res.set('Allow', 'GET').sendStatus(405);
});

/**
 * GET /api/v1/creators/leaderboard
 *
 * List creators ranked by holder count descending, tie-broken
 * alphabetically by creator address.
 */
creatorsRouter.get(
   '/leaderboard',
   createCreatorReadMetricsMiddleware('list'),
   httpGetCreatorLeaderboard
);

/**
 * GET /api/v1/creators/leaderboard/volume
 *
 * Top 20 creator keys ranked by total trading volume (buys + sells) over a
 * rolling window (default 7 days, LEADERBOARD_VOLUME_WINDOW_DAYS). Cached in
 * Redis for LEADERBOARD_VOLUME_CACHE_TTL_SECONDS (default 5 minutes) and
 * invalidated whenever a new trade is indexed.
 */
creatorsRouter.get(
   '/leaderboard/volume',
   createCreatorReadMetricsMiddleware('list'),
   httpGetVolumeLeaderboard
);

/**
 * GET /api/v1/creators/:id
 *
 * Get public details for a specific creator.
 * Public endpoint with 5-minute cache.
 */
creatorsRouter.get(
   '/:id',
   validateCreatorParam('id'),
   createCreatorReadMetricsMiddleware('detail'),
   cacheControl(
      CREATOR_PUBLIC_ROUTE_CACHE_PRESETS[CREATOR_PUBLIC_ROUTE_NAMES.GET_PROFILE]
   ),
   httpGetCreator
);
// 405 handler for /:id
creatorsRouter.all('/:id', (_req, res) => {
   res.set('Allow', 'GET').sendStatus(405);
});

/**
 * GET /api/v1/creators/:keyId/revenue
 *
 * Creator revenue summary: total royalties earned and trade count.
 * Requires JWT matching the key creator.
 */
creatorsRouter.get(
   '/:keyId/revenue',
   requireKeyCreator('keyId'),
   async (req, res, next) => {
      try {
         const keyId = Array.isArray(req.params.keyId)
            ? req.params.keyId[0]
            : req.params.keyId;
         sendSuccess(res, await getCreatorRevenue(keyId));
      } catch (error) {
         if (error instanceof RevenueKeyNotFoundError) {
            sendNotFound(res, 'Key');
            return;
         }
         next(error);
      }
   }
);
creatorsRouter.all('/:keyId/revenue', (_req, res) => {
   res.set('Allow', 'GET').sendStatus(405);
});

/**
 * GET /api/v1/creators/:keyId/dashboard
 *
 * Creator dashboard summary: key stats, revenue, and holder metrics in one call.
 * Requires JWT matching the key creator. Cached in Redis for 2 minutes.
 */
creatorsRouter.get(
   '/:keyId/dashboard',
   requireKeyCreator('keyId'),
   httpGetCreatorDashboard
);
creatorsRouter.all('/:keyId/dashboard', (_req, res) => {
   res.set('Allow', 'GET').sendStatus(405);
});

/**
 * POST /api/v1/creators/:keyId/proposals
 *
 * Proposal creation: submits create_proposal contract call and persists proposal record.
 * Requires JWT matching the key creator.
 */
creatorsRouter.post(
   '/:keyId/proposals',
   requireKeyCreator('keyId'),
   validateBody(createProposalSchema),
   httpCreateCreatorProposal
);
creatorsRouter.all('/:keyId/proposals', (_req, res) => {
   res.set('Allow', 'POST').sendStatus(405);
});

export default creatorsRouter;
