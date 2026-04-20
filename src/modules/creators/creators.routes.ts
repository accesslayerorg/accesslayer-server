import { Router } from 'express';
import { httpListCreators, httpGetCreatorStats } from './creators.controllers';
import {
   cacheControl,
   CachePresets,
} from '../../middlewares/cache-control.middleware';
import { validateCreatorIdParam } from '../creator/creator.middleware';

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
 * Get public stats for a creator by ID.
 * Param validation is handled by validateCreatorIdParam middleware.
 */
creatorsRouter.get(
   '/:id/stats',
   validateCreatorIdParam,
   httpGetCreatorStats
);

export default creatorsRouter;
