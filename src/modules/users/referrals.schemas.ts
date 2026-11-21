// src/modules/users/referrals.schemas.ts
// Request/response contracts for GET /api/v1/users/:wallet/referrals.

import { z } from 'zod';
import { safeIntParam } from '../../utils/query.utils';
import { MIN_PAGE_SIZE, MAX_PAGE_SIZE } from '../../constants/pagination.constants';

export const DEFAULT_REFERRAL_PAGE_SIZE = 20;

export const ReferralBreakdownQuerySchema = z
   .object({
      limit: safeIntParam({
         defaultValue: DEFAULT_REFERRAL_PAGE_SIZE,
         min: MIN_PAGE_SIZE,
         max: MAX_PAGE_SIZE,
         label: 'Limit',
      }),
      cursor: z.string().optional(),
   })
   .strict();

export type ReferralBreakdownQueryType = z.infer<
   typeof ReferralBreakdownQuerySchema
>;

/** Opaque cursor payload for the breakdown list. */
export interface ReferralCursorPayload {
   /** ISO timestamp of the last item on the previous page. */
   createdAt: string;
   /** Row id of the last item on the previous page (tiebreaker). */
   id: string;
}

export const ReferralBreakdownItemSchema = z.object({
   keyId: z.string(),
   creatorName: z.string().nullable(),
   amount: z.number(),
   timestamp: z.string(),
});

export type ReferralBreakdownItem = z.infer<typeof ReferralBreakdownItemSchema>;

export const ReferralSummarySchema = z.object({
   totalEarned: z.number(),
   referralCount: z.number(),
});

export type ReferralSummary = z.infer<typeof ReferralSummarySchema>;
