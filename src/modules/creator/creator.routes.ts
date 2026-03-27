// src/modules/creator/creator.routes.ts
import { Router } from 'express';
import { listCreators, getCreatorStats } from './creator.controller';
import { validateCreatorIdParam } from './creator.middleware';
import { ROOT as CREATORS_ROOT } from '../../constants/creator.constants';

const router = Router();

/**
 * @route GET /api/v1/creators
 * @desc Get a paginated list of creators
 * @access Public
 */
router.get(CREATORS_ROOT, listCreators);

/**
 * @route GET /api/v1/creators/:id/stats
 * @desc Get stats for a creator by id
 * @access Public
 */
router.get('/:id/stats', validateCreatorIdParam, getCreatorStats);

export default router;
