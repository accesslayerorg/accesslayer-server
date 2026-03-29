// src/modules/creator/creator.routes.ts
import { Router } from 'express';
import { listCreators } from './creator.controller';
import {
   getCreatorProfileHandler,
   upsertCreatorProfileHandler,
} from './creator-profile.handlers';
import { ROOT as CREATORS_ROOT } from '../../constants/creator.constants';
import { cacheControl } from '../../middlewares/cache-control.middleware';
import { CREATOR_PUBLIC_ROUTE_CACHE_PRESETS } from '../../constants/creator-public-cache.constants';

const router = Router();

/**
 * Creator module route map:
 *
 * - GET /api/v1/creators
 * - GET /api/v1/creators/:creatorId/profile
 * - PUT /api/v1/creators/:creatorId/profile
 *
 * Note: The legacy creators list route is no longer mounted from `src/modules/index.ts` because
 * `src/modules/creators/creators.routes.ts` is the active public endpoint.
 */

/**
 * @route GET /api/v1/creators
 * @desc Get a paginated list of creators
 * @access Public
 */
router.get(
   CREATORS_ROOT,
   cacheControl(CREATOR_PUBLIC_ROUTE_CACHE_PRESETS.creatorList),
   listCreators
);

/**
 * @route GET /api/v1/creators/:creatorId/profile
 * @desc Get creator profile scaffold payload
 * @access Public
 */
router.get(
   '/:creatorId/profile',
   cacheControl(CREATOR_PUBLIC_ROUTE_CACHE_PRESETS.creatorProfile),
   getCreatorProfileHandler
);

/**
 * @route PUT /api/v1/creators/:creatorId/profile
 * @desc Upsert creator profile scaffold payload
 * @access Public for scaffold (auth follow-up required)
 */
router.put('/:creatorId/profile', upsertCreatorProfileHandler);

export default router;
