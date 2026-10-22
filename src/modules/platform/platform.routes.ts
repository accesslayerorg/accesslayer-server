// src/modules/platform/platform.routes.ts
// Platform pause state endpoint (#988).

import { Router } from 'express';
import { sendSuccess } from '../../utils/api-response.utils';
import { getPlatformPauseState } from './platform-pause.service';

const platformRouter = Router();

/**
 * GET /platform/status
 *
 * Returns the current platform pause state plus the metadata of the pause
 * that put it there: `{ paused, pausedAt, actor }`. No authentication
 * required. Backed by the cached state written by the PlatformPaused /
 * PlatformResumed indexer, so it reflects pauses within seconds.
 */
platformRouter.get('/status', async (_req, res, next) => {
   try {
      sendSuccess(res, await getPlatformPauseState());
   } catch (error) {
      next(error);
   }
});

export default platformRouter;
