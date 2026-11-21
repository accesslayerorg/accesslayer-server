// src/modules/referrals/referral-earnings.routes.ts
// Referral earnings endpoints (#1057). All routes are wallet-scoped: the JWT
// wallet must equal the `:wallet` path param (401 otherwise).

import { Router } from 'express';
import { requireWalletParamMatch } from '../../middlewares/jwt-auth.middleware';
import {
   httpGetReferralEarnings,
   httpGetReferralEarningsSummary,
} from './referral-earnings.controller';

const referralRouter = Router();

/**
 * GET /api/v1/referrals/:wallet/earnings?limit=&cursor=&from=&to=
 * Paginated referral earnings history (newest first) with an optional
 * inclusive date range.
 */
referralRouter.get(
   '/:wallet/earnings',
   requireWalletParamMatch('wallet'),
   httpGetReferralEarnings
);
referralRouter.all('/:wallet/earnings', (_req, res) => {
   res.set('Allow', 'GET').sendStatus(405);
});

/**
 * GET /api/v1/referrals/:wallet/summary
 * Total earnings, tier 1/2/3 breakdown, and referred wallet count.
 */
referralRouter.get(
   '/:wallet/summary',
   requireWalletParamMatch('wallet'),
   httpGetReferralEarningsSummary
);
referralRouter.all('/:wallet/summary', (_req, res) => {
   res.set('Allow', 'GET').sendStatus(405);
});

export default referralRouter;
