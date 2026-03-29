import { Router } from 'express';
import { httpListCreators } from './creators.controllers';
import { cacheControl } from '../../middlewares/cache-control.middleware';
import { CREATOR_PUBLIC_ROUTE_CACHE_PRESETS } from '../../constants/creator-public-cache.constants';

const creatorsRouter = Router();

/**
 * GET /api/v1/creators
 *
 * List all creators with pagination and filtering.
 * Public endpoint with 5-minute cache.
 */
creatorsRouter.get(
   '/',
   cacheControl(CREATOR_PUBLIC_ROUTE_CACHE_PRESETS.creatorList),
   httpListCreators
);

export default creatorsRouter;
