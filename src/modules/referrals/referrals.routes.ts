// src/modules/referrals/referrals.routes.ts
// Referral tracking and reward distribution routes (#910). All routes require
// a JWT; the wallet is taken from the token so callers can only read or write
// their own referral data.

import { Router } from 'express';
import { requireJwtAuth } from '../../middlewares/jwt-auth.middleware';
import {
   httpGetReferralEarnings,
   httpGetReferralHistory,
   httpGetReferralStats,
   httpGetReferredWallets,
   httpBuildReferralClaim,
   httpRegisterReferral,
} from './referrals.controller';

const referralRouter = Router();

/**
 * POST /api/v1/referrals/register
 *
 * Registers the authenticated wallet as a referee of the wallet that owns the
 * supplied referral code. Returns 409 when the wallet was already referred.
 */
referralRouter.post('/register', requireJwtAuth, httpRegisterReferral);

/**
 * GET /api/v1/referrals/earnings
 *
 * Total referral earnings for the authenticated wallet plus a per-referral
 * breakdown, and the wallet's own referral code to share.
 */
referralRouter.get('/earnings', requireJwtAuth, httpGetReferralEarnings);

/**
 * GET /api/v1/referrals/referred
 *
 * Referred wallets with their join date and first-trade status.
 */
referralRouter.get('/referred', requireJwtAuth, httpGetReferredWallets);

/**
 * GET /api/v1/referrals/stats?wallet=...
 * Aggregated referral count, lifetime earnings, and current on-chain balance.
 */
referralRouter.get('/stats', requireJwtAuth, httpGetReferralStats);

/** GET /api/v1/referrals/history?wallet=... — newest reward event first. */
referralRouter.get('/history', requireJwtAuth, httpGetReferralHistory);

/** POST /api/v1/referrals/claim — builds an unsigned claim for one creator key. */
referralRouter.post('/claim', requireJwtAuth, httpBuildReferralClaim);

// 405 handlers so unsupported methods get a proper Allow header.
referralRouter.all('/register', (_req, res) => {
   res.set('Allow', 'POST').sendStatus(405);
});
referralRouter.all('/earnings', (_req, res) => {
   res.set('Allow', 'GET').sendStatus(405);
});
referralRouter.all('/referred', (_req, res) => {
   res.set('Allow', 'GET').sendStatus(405);
});
referralRouter.all('/stats', (_req, res) => {
   res.set('Allow', 'GET').sendStatus(405);
});
referralRouter.all('/history', (_req, res) => {
   res.set('Allow', 'GET').sendStatus(405);
});
referralRouter.all('/claim', (_req, res) => {
   res.set('Allow', 'POST').sendStatus(405);
});

export default referralRouter;
