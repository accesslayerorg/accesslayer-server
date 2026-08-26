// src/modules/analytics/analytics.routes.ts
// Route wiring for creator key analytics.

import { Router } from 'express';
import { requireWalletAuth } from '../../middlewares/auth-wallet.middleware';
import { httpGetKeyAnalytics } from './analytics.controller';

const analyticsRouter = Router();

/**
 * GET /creator/:keyId/analytics
 *
 * Returns a 30-day daily time series (activeHolders, tradeVolume, newHolders)
 * for the given creator key. Requires a JWT whose wallet matches the key
 * creator (403 otherwise). Responses are cached in Redis for 10 minutes and
 * invalidated whenever a trade for the key is recorded.
 */
analyticsRouter.get(
   '/creator/:keyId/analytics',
   requireWalletAuth,
   httpGetKeyAnalytics
);

export default analyticsRouter;
