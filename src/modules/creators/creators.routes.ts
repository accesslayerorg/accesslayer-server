import { Router } from 'express';
import { httpListCreators, httpGetCreatorStats } from './creators.controllers';
import { validateCreatorParams } from './creators.middleware';
import {
   cacheControl,
   CachePresets,
} from '../../middlewares/cache-control.middleware';

const creatorsRouter = Router();

/**
 * GET /api/v1/creators
 *
 * List all creators with pagination and filtering.
 * Public endpoint with 5-minute cache.
 */
creatorsRouter.get(
   '/',
   cacheControl(CachePresets.publicShort),
   httpListCreators
);

/**
 * GET /api/v1/creators/:id/stats
 *
 * Returns public stats for a specific creator.
 * Validates the creator ID param before the handler runs.
 */
creatorsRouter.get(
   '/:id/stats',
   validateCreatorParams,
   cacheControl(CachePresets.publicShort),
   httpGetCreatorStats
);

export default creatorsRouter;
