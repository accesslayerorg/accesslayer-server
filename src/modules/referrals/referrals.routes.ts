// src/modules/referrals/referrals.routes.ts
// Route wiring for per-wallet referral earnings.

import { Router } from 'express';
import { requireWalletAuth } from '../../middlewares/auth-wallet.middleware';
import { httpGetReferrals } from './referrals.controller';

const referralsRouter = Router();

/**
 * GET /users/:wallet/referrals
 *
 * Returns totalEarned (XLM) and referralCount plus a cursor-paginated breakdown
 * of the referral events that generated them. Requires a JWT whose wallet
 * matches the path param (401 otherwise). The summary is cached in Redis for
 * 2 minutes and invalidated when a new referral_fee_paid event is recorded.
 */
referralsRouter.get(
   '/users/:wallet/referrals',
   requireWalletAuth,
   httpGetReferrals
);

export default referralsRouter;
