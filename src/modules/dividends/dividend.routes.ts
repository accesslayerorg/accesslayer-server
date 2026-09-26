import { requireJwtAuth } from '../../middlewares/jwt-auth.middleware';
import { Router } from 'express';
import {
   httpGetDividendDistributions,
   httpGetDividendHolders,
   httpDistributeDividend,
} from './dividend.controllers';

const dividendRouter = Router();

/**
 * GET /keys/:keyId/dividends
 * Public endpoint - no authentication required
 * Returns all past dividend distributions for a creator key
 */
dividendRouter.get('/:keyId/dividends', httpGetDividendDistributions);

/**
 * GET /keys/:keyId/dividends/:distributionId/holders
 * Public endpoint - no authentication required
 * Returns per-holder payout breakdown for a specific distribution
 */
dividendRouter.get(
   '/:keyId/dividends/:distributionId/holders',
   httpGetDividendHolders
);

/**
 * POST /keys/:keyId/dividends or /creator/:keyId/dividends
 * Submits distribute_dividend and records the distribution.
 */
dividendRouter.post(
   '/:keyId/dividends',
   requireJwtAuth,
   httpDistributeDividend
);
dividendRouter.post(
   '/creator/:keyId/dividends',
   requireJwtAuth,
   httpDistributeDividend
);

export default dividendRouter;
