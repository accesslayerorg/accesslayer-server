// src/modules/referrals/referrals.schemas.ts
// Request/response contracts for the referral programme endpoints (#910):
//   POST /referrals/register
//   GET  /referrals/earnings
//   GET  /referrals/referred

import { z } from 'zod';
import { safeIntParam } from '../../utils/query.utils';
import { MIN_PAGE_SIZE, MAX_PAGE_SIZE } from '../../constants/pagination.constants';
import { DEFAULT_REFERRED_PAGE_SIZE } from './referrals.constants';

/** POST /referrals/register body. */
export const RegisterReferralSchema = z
   .object({
      /**
       * Referral code shared by the referrer. Issued per wallet and
       * retrieved via GET /referrals/earnings.
       */
      referralCode: z
         .string()
         .trim()
         .min(1, 'referralCode is required')
         .max(64, 'referralCode must be at most 64 characters')
         .transform((code) => code.toUpperCase()),
   })
   .strict();

export type RegisterReferralInput = z.infer<typeof RegisterReferralSchema>;

/** GET /referrals/referred query. */
export const ReferredWalletsQuerySchema = z
   .object({
      limit: safeIntParam({
         defaultValue: DEFAULT_REFERRED_PAGE_SIZE,
         min: MIN_PAGE_SIZE,
         max: MAX_PAGE_SIZE,
         label: 'Limit',
      }),
      cursor: z.string().optional(),
   })
   .strict();

export type ReferredWalletsQuery = z.infer<typeof ReferredWalletsQuerySchema>;

/** Opaque cursor payload for the referred wallets list. */
export interface ReferredCursorPayload {
   /** ISO timestamp the list is ordered by (referral join time). */
   joinedAt: string;
   /** Row id of the last item on the previous page (tiebreaker). */
   id: string;
}

/**
 * First-trade status of a referred wallet. `PENDING` means the wallet has
 * joined but has not traded yet, so no reward has been paid out.
 */
export const ReferralStatusSchema = z.enum(['PENDING', 'ACTIVE']);
export type ReferralStatus = z.infer<typeof ReferralStatusSchema>;

export const ReferredWalletSchema = z.object({
   refereeAddress: z.string(),
   joinedAt: z.string(),
   firstTradeAt: z.string().nullable(),
   hasCompletedFirstTrade: z.boolean(),
   status: ReferralStatusSchema,
   earnedXlm: z.number(),
});
export type ReferredWallet = z.infer<typeof ReferredWalletSchema>;

export const ReferralEarningsSchema = z.object({
   referralCode: z.string(),
   totalEarned: z.number(),
   /** Number of referred wallets that have paid out a reward so far. */
   rewardedReferralCount: z.number(),
   /** Number of wallets currently registered as referred by this wallet. */
   referredCount: z.number(),
});
export type ReferralEarnings = z.infer<typeof ReferralEarningsSchema>;

export const ReferralEarningsBreakdownItemSchema = z.object({
   refereeAddress: z.string(),
   joinedAt: z.string(),
   firstTradeAt: z.string().nullable(),
   status: ReferralStatusSchema,
   earnedXlm: z.number(),
});
export type ReferralEarningsBreakdownItem = z.infer<
   typeof ReferralEarningsBreakdownItemSchema
>;
