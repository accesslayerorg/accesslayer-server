// src/modules/referrals/referral-tier.routes.ts
// Referral tier endpoints (#1034). The wallet is supplied as a `wallet` query
// parameter and must match the JWT wallet (401 otherwise).

import { Router } from 'express';
import { requireWalletQueryMatch } from '../../middlewares/jwt-auth.middleware';
import {
   httpGetReferralTier,
   httpGetReferralTierHistory,
} from './referral-tier.controller';

const referralTierRouter = Router();

/**
 * GET /api/v1/referrals/tier?wallet=
 * Current tier, cumulative volume, next threshold and reward rate (bps).
 */
referralTierRouter.get(
   '/tier',
   requireWalletQueryMatch('wallet'),
   httpGetReferralTier
);

/**
 * GET /api/v1/referrals/tier/history?wallet=&limit=&cursor=
 * Cursor-paginated tier upgrade history, newest first.
 */
referralTierRouter.get(
   '/tier/history',
   requireWalletQueryMatch('wallet'),
   httpGetReferralTierHistory
);

referralTierRouter.all('/tier', (_req, res) => {
   res.set('Allow', 'GET').sendStatus(405);
});
referralTierRouter.all('/tier/history', (_req, res) => {
   res.set('Allow', 'GET').sendStatus(405);
});

export default referralTierRouter;
