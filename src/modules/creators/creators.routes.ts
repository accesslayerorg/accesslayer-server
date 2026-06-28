import { Router } from 'express';
import { httpListCreators, httpGetCreatorStats } from './creators.controllers';
import { httpGetCreatorHolders } from './creator-holders.controller';
import { cacheControl } from '../../middlewares/cache-control.middleware';
import { CREATOR_PUBLIC_ROUTE_CACHE_PRESETS } from '../../constants/creator-public-cache.constants';
import { CREATOR_PUBLIC_ROUTE_NAMES } from '../../constants/creator-public-routes.constants';
import { createCreatorReadMetricsMiddleware } from '../../utils/creator-read-metrics.utils';
import { normalizeTrailingSlash } from '../../middlewares/trailing-slash-normalizer.middleware';
import { validateCreatorParam } from '../../middlewares/creator-param.middleware';

const creatorsRouter = Router();

// Normalize trailing slashes for all creator routes so that, e.g.,
// GET /api/v1/creators/ reaches the same handler as GET /api/v1/creators.
// Scoped to this router to avoid side-effects on other route groups.
creatorsRouter.use(normalizeTrailingSlash);

/**
 * GET /api/v1/creators
 *
 * List all creators with pagination and filtering.
 * Public endpoint with 5-minute cache.
 */
creatorsRouter.get(
   '/',
   createCreatorReadMetricsMiddleware('list'),
   cacheControl(CREATOR_PUBLIC_ROUTE_CACHE_PRESETS[CREATOR_PUBLIC_ROUTE_NAMES.LIST]),
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
   cacheControl(CREATOR_PUBLIC_ROUTE_CACHE_PRESETS[CREATOR_PUBLIC_ROUTE_NAMES.GET_STATS]),
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
   cacheControl(CREATOR_PUBLIC_ROUTE_CACHE_PRESETS[CREATOR_PUBLIC_ROUTE_NAMES.GET_HOLDERS]),
   httpGetCreatorHolders
);
// 405 handler for /:id/holders
creatorsRouter.all('/:id/holders', (_req, res) => {
   res.set('Allow', 'GET').sendStatus(405);
});

export default creatorsRouter;