import { Router } from 'express';
import { httpGetActivityFeed } from './activity.controllers';

const activityRouter = Router();

/**
 * GET /api/v1/activity
 * 
 * Public activity feed with optional filtering by creator, actor, or type.
 */
activityRouter.get('/', httpGetActivityFeed);

export default activityRouter;
