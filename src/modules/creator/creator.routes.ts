// src/modules/creator/creator.routes.ts
import { Router } from 'express';
import { listCreators } from './creator.controller';
import {
   getCreatorProfileHandler,
   upsertCreatorProfileHandler,
} from './creator-profile.handlers';
import { ROOT as CREATORS_ROOT } from '../../constants/creator.constants';

const router = Router();

/**
 * Creator module route map (initial scaffold):
 *
 * - GET /api/v1/creators
 * - GET /api/v1/creators/:creatorId/profile
 * - PUT /api/v1/creators/:creatorId/profile
 */

/**
 * @route GET /api/v1/creators
 * @desc Get a paginated list of creators
 * @access Public
 */
router.get(CREATORS_ROOT, listCreators);

/**
 * @route GET /api/v1/creators/:creatorId/profile
 * @desc Get creator profile scaffold payload
 * @access Public
 */
router.get('/:creatorId/profile', getCreatorProfileHandler);

/**
 * @route PUT /api/v1/creators/:creatorId/profile
 * @desc Upsert creator profile scaffold payload
 * @access Public for scaffold (auth follow-up required)
 */
router.put('/:creatorId/profile', upsertCreatorProfileHandler);

export default router;
