import { Router } from 'express';
import { httpGetHolderDividends } from './dividend.controllers';

const holdersRouter = Router();

/**
 * GET /holders/:wallet/dividends
 * Public endpoint - no authentication required
 * Returns aggregate pending and claimed dividends across all held keys for a wallet.
 */
holdersRouter.get('/:wallet/dividends', httpGetHolderDividends);

export default holdersRouter;
