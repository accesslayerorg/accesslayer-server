import { Router } from 'express';
import { httpListCreators, httpGetCreatorStats } from './creators.controllers';
import { cacheControl } from '../../middlewares/cache-control.middleware';
import { CREATOR_PUBLIC_ROUTE_CACHE_PRESETS } from '../../constants/creator-public-cache.constants';
import { CREATOR_PUBLIC_ROUTE_NAMES } from '../../constants/creator-public-routes.constants';

const creatorsRouter = Router();

/**
 * GET /api/v1/creators
 *
 * List all creators with pagination and filtering.
 * Public endpoint with 5-minute cache.
 */
creatorsRouter.get(
   '/',
   cacheControl(CREATOR_PUBLIC_ROUTE_CACHE_PRESETS[CREATOR_PUBLIC_ROUTE_NAMES.LIST]),
   httpListCreators
);

/**
 * GET /api/v1/creators/:id/stats
 *
 * Get public stats for a specific creator.
 * Public endpoint with 5-minute cache.
 */
creatorsRouter.get(
   '/:id/stats',
   cacheControl(CREATOR_PUBLIC_ROUTE_CACHE_PRESETS[CREATOR_PUBLIC_ROUTE_NAMES.GET_STATS]),
   httpGetCreatorStats
);

export default creatorsRouter;
