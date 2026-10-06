// src/modules/portfolio/portfolio.routes.ts
// Portfolio P&L routes (#897). All routes require a JWT; the wallet is taken
// from the token (no :wallet param) and pricing is always live (no cache).

import { Router } from 'express';
import { requireJwtAuth } from '../../middlewares/jwt-auth.middleware';
import { httpGetPortfolioPnl } from './portfolio-pnl.controller';

const portfolioRouter = Router();

/**
 * GET /api/v1/portfolio/pnl
 *
 * Per-position unrealised P&L for the authenticated wallet using the live
 * bonding-curve sell price, plus realised P&L and portfolio totals.
 */
portfolioRouter.get('/pnl', requireJwtAuth, httpGetPortfolioPnl);

portfolioRouter.all('/pnl', (_req, res) => {
   res.set('Allow', 'GET').sendStatus(405);
});

export default portfolioRouter;
