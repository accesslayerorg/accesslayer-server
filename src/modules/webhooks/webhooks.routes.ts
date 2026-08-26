// src/modules/webhooks/webhooks.routes.ts
// Route wiring for inbound indexer/webhook events.

import { Router } from 'express';
import { httpReferralFeeWebhook } from './webhooks.controller';

const webhooksRouter = Router();

/**
 * POST /webhooks/referral-fee
 *
 * Indexer pushes a referral_fee_paid event here. The handler persists the fee
 * and invalidates the wallet's cached referral summary so the next profile
 * fetch reflects fresh totals.
 */
webhooksRouter.post('/referral-fee', httpReferralFeeWebhook);

export default webhooksRouter;
