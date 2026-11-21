// src/modules/portfolio/portfolio.routes.ts
//
// - /pnl (#897) requires a JWT; the wallet is taken from the token and
//   pricing is always live (no cache).
// - /history (#1008) is a public read of public on-chain data: the wallet
//   comes from the query string and the series is cached for 5 minutes per
//   wallet per range.

import { Router } from 'express';
import { requireJwtAuth } from '../../middlewares/jwt-auth.middleware';
import {
   cacheControl,
   CachePresets,
} from '../../middlewares/cache-control.middleware';
import { httpGetPortfolioPnl } from './portfolio-pnl.controller';
import { httpGetPortfolioHistory } from './portfolio-history.controller';

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

/**
 * GET /api/v1/portfolio/history?wallet=&range=7d|30d|90d|all
 *
 * Total value of the wallet's creator key holdings at regular intervals
 * (hourly for 7d, daily for 30d/90d, weekly for all time) plus the
 * percentage return from the first to the last point.
 */
portfolioRouter.get(
   '/history',
   cacheControl(CachePresets.publicShort),
   httpGetPortfolioHistory
);

portfolioRouter.all('/history', (_req, res) => {
   res.set('Allow', 'GET').sendStatus(405);
});

export default portfolioRouter;
