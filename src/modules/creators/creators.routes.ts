import { Router } from 'express';
import { httpListCreators } from './creators.controllers';
import { cacheControl } from '../../middlewares/cache-control.middleware';
import { PUBLIC_ENDPOINT_CACHE_PRESETS } from '../../constants/public-endpoint-cache.constants';

const creatorsRouter = Router();

/**
 * GET /api/v1/creators
 *
 * List all creators with pagination and filtering.
 * Public endpoint with 5-minute cache.
 */
creatorsRouter.get(
   '/',
   cacheControl(PUBLIC_ENDPOINT_CACHE_PRESETS.short),
   httpListCreators
);

export default creatorsRouter;
