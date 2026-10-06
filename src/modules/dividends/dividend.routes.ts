import { requireJwtAuth } from '../../middlewares/jwt-auth.middleware';
import { Router } from 'express';
import {
   httpGetDividendDistributions,
   httpGetDividendHolders,
   httpDistributeDividend,
   httpGetHolderDividends,
   httpBuildClaimTransaction,
} from './dividend.controllers';

const dividendRouter = Router();

/**
 * GET /keys/:keyId/dividends
 * Public endpoint - no authentication required
 * Returns all past dividend distributions for a creator key with pagination.
 */
dividendRouter.get('/:keyId/dividends', httpGetDividendDistributions);

/**
 * POST /keys/:keyId/dividends/claim
 * Public / authenticated endpoint
 * Builds and returns an unsigned Soroban claim transaction for a key.
 */
dividendRouter.post('/:keyId/dividends/claim', httpBuildClaimTransaction);

/**
 * GET /holders/:wallet/dividends
 * Public endpoint - no authentication required
 * Returns aggregate pending and claimed dividends across all held keys.
 */
dividendRouter.get('/holders/:wallet/dividends', httpGetHolderDividends);

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
dividendRouter.post('/:keyId/dividends', requireJwtAuth, httpDistributeDividend);
dividendRouter.post('/creator/:keyId/dividends', requireJwtAuth, httpDistributeDividend);

export default dividendRouter;

