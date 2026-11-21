import { Router } from 'express';
import { httpGetActivityFeed } from './activity.controllers';
import { httpGetPlatformActivityFeed } from './activity-feed.controllers';
import { cacheControl } from '../../middlewares/cache-control.middleware';
import { ACTIVITY_FEED_CACHE_PRESET } from '../../constants/activity-feed-cache.constants';

const activityRouter = Router();

/**
 * GET /api/v1/activity/feed
 *
 * Platform-wide activity feed (#936): last 20 events, reverse-chronological,
 * cursor pagination for older events. Must be registered before the `/`
 * catch-all filtered feed below.
 */
activityRouter.get('/feed', httpGetPlatformActivityFeed);

/**
 * GET /api/v1/activity
 *
 * Public activity feed with optional filtering by creator, actor, or type.
 * Cached for 2 minutes to reduce database load while maintaining reasonable freshness.
 */
activityRouter.get(
   '/',
   cacheControl(ACTIVITY_FEED_CACHE_PRESET),
   httpGetActivityFeed
);

export default activityRouter;
