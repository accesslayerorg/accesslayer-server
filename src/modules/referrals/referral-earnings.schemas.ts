// src/modules/referrals/referral-earnings.schemas.ts
// Request/response contracts for the referral earnings REST endpoints (#1057):
//   GET /api/v1/referrals/:wallet/earnings
//   GET /api/v1/referrals/:wallet/summary

import { z } from 'zod';
import {
   MAX_PAGE_SIZE,
   MIN_PAGE_SIZE,
} from '../../constants/pagination.constants';

export const DEFAULT_REFERRAL_EARNINGS_PAGE_SIZE = 20;

/**
 * Accepts either a bare ISO date (`2026-08-20`) or a full ISO timestamp
 * (`2026-08-20T10:00:00.000Z`). Both parse cleanly via `Date.parse`.
 */
const isoDateParam = (label: string) =>
   z
      .string()
      .trim()
      .min(1, `${label} must not be empty`)
      .refine(value => !Number.isNaN(Date.parse(value)), {
         message: `${label} must be a valid ISO date or timestamp`,
      });

/** Query params for GET /referrals/:wallet/earnings. */
export const ReferralEarningsQuerySchema = z
   .object({
      limit: z.coerce
         .number()
         .int()
         .min(MIN_PAGE_SIZE)
         .max(MAX_PAGE_SIZE)
         .optional()
         .default(DEFAULT_REFERRAL_EARNINGS_PAGE_SIZE),
      cursor: z.string().min(1).optional(),
      from: isoDateParam('from').optional(),
      to: isoDateParam('to').optional(),
   })
   .strict()
   .refine(
      query =>
         !query.from || !query.to || Date.parse(query.from) <= Date.parse(query.to),
      {
         message: 'from must be earlier than or equal to to',
         path: ['from'],
      }
   );

export type ReferralEarningsQuery = z.infer<typeof ReferralEarningsQuerySchema>;

/** Opaque cursor payload for the earnings list (keyset pagination). */
export interface ReferralEarningsCursorPayload {
   /** ISO timestamp of the last item on the previous page. */
   earnedAt: string;
   /** Row id of the last item on the previous page (tiebreaker). */
   id: string;
}

export const ReferralEarningItemSchema = z.object({
   id: z.string(),
   tier: z.number().int(),
   amount: z.number(),
   sourceWallet: z.string(),
   earnedAt: z.string(),
   txHash: z.string().nullable(),
});

export type ReferralEarningItem = z.infer<typeof ReferralEarningItemSchema>;

export const ReferralEarningsSummarySchema = z.object({
   /** Total XLM earned across all tiers. */
   totalEarnings: z.number(),
   /** Number of individual reward payouts. */
   earningsCount: z.number().int(),
   /** Number of distinct referred wallets that generated earnings. */
   referredWalletCount: z.number().int(),
   /** Per-tier accumulated earnings (tier1 + tier2 + tier3 = totalEarnings). */
   tiers: z.object({
      tier1: z.number(),
      tier2: z.number(),
      tier3: z.number(),
   }),
});

export type ReferralEarningsSummary = z.infer<
   typeof ReferralEarningsSummarySchema
>;
