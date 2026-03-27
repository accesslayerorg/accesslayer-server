// src/modules/creator/creator.routes.ts
import { Router } from 'express';
import { listCreators } from './creator.controller';
import { ROOT as CREATORS_ROOT } from '../../constants/creator.constants';

const router = Router();

/**
 * @route GET /api/v1/creators
 * @desc Get a paginated list of creators
 * @access Public
 */
router.get(CREATORS_ROOT, listCreators);

export default router;
