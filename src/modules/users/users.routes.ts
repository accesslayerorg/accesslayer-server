// src/modules/users/users.routes.ts
// Wallet-scoped user endpoints. All routes require a JWT whose wallet claim
// matches the :wallet path parameter.

import { Router } from 'express';
import { requireWalletParamMatch } from '../../middlewares/jwt-auth.middleware';
import { httpGetWalletReferrals } from './referrals.controller';
import { httpGetWalletHoldings } from './holdings.controller';

const usersRouter = Router();

/**
 * GET /api/v1/users/:wallet/holdings
 *
 * Portfolio holdings for the authenticated wallet including lockup data.
 */
usersRouter.get(
   '/:wallet/holdings',
   requireWalletParamMatch('wallet'),
   httpGetWalletHoldings
);

/**
 * GET /api/v1/users/:wallet/referrals
 *
 * Aggregated referral earnings plus a cursor-paginated breakdown.
 */
usersRouter.get(
   '/:wallet/referrals',
   requireWalletParamMatch('wallet'),
   httpGetWalletReferrals
);

// 405 handlers for both resource paths
usersRouter.all('/:wallet/holdings', (_req, res) => {
   res.set('Allow', 'GET').sendStatus(405);
});
usersRouter.all('/:wallet/referrals', (_req, res) => {
   res.set('Allow', 'GET').sendStatus(405);
});

export default usersRouter;
