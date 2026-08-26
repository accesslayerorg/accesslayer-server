// src/modules/webhooks/webhooks.controller.ts
// Inbound chain/indexer events that mutate cached aggregates.

import { z } from 'zod';
import { AsyncController } from '../../types/auth.types';
import { sendSuccess, sendValidationError } from '../../utils/api-response.utils';
import { recordReferralFee } from '../referrals/referrals.service';

const ReferralFeeEventSchema = z.object({
   wallet: z.string().min(1),
   keyId: z.string().min(1),
   creatorId: z.string().min(1),
   creatorName: z.string().min(1),
   amount: z.number().min(0),
   txHash: z.string().min(1),
});

/**
 * POST /webhooks/referral-fee
 *
 * Receives a `referral_fee_paid` event from the indexer, persists the referral
 * fee, and invalidates the recipient wallet's cached referral summary.
 */
export const httpReferralFeeWebhook: AsyncController = async (req, res, next) => {
   try {
      const parsed = ReferralFeeEventSchema.safeParse(req.body);
      if (!parsed.success) {
         return sendValidationError(
            res,
            'Invalid referral fee event',
            parsed.error.issues.map((i) => ({
               field: i.path.join('.'),
               message: i.message,
            }))
         );
      }

      await recordReferralFee(parsed.data);
      return sendSuccess(res, { received: true });
   } catch (error) {
      next(error);
   }
};
