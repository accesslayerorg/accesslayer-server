// src/modules/referrals/referral-tier.schemas.ts
// Request/response contracts for the referral tier endpoints (#1034):
//   GET /api/v1/referrals/tier?wallet=
//   GET /api/v1/referrals/tier/history?wallet=&limit=&cursor=

import { z } from 'zod';
import { safeIntParam } from '../../utils/query.utils';
import {
   MAX_PAGE_SIZE,
   MIN_PAGE_SIZE,
} from '../../constants/pagination.constants';

export const DEFAULT_REFERRAL_TIER_HISTORY_PAGE_SIZE = 20;

/** Query params for GET /referrals/tier. */
export const ReferralTierQuerySchema = z
   .object({
      wallet: z.string().trim().min(1, 'wallet is required'),
   })
   .strict();

export type ReferralTierQuery = z.infer<typeof ReferralTierQuerySchema>;

/** Query params for GET /referrals/tier/history. */
export const ReferralTierHistoryQuerySchema = z
   .object({
      wallet: z.string().trim().min(1, 'wallet is required'),
      limit: safeIntParam({
         defaultValue: DEFAULT_REFERRAL_TIER_HISTORY_PAGE_SIZE,
         min: MIN_PAGE_SIZE,
         max: MAX_PAGE_SIZE,
         label: 'Limit',
      }),
      cursor: z.string().optional(),
   })
   .strict();

export type ReferralTierHistoryQuery = z.infer<
   typeof ReferralTierHistoryQuerySchema
>;

/** Opaque cursor payload for the tier history list. */
export interface ReferralTierCursorPayload {
   /** ISO timestamp of the last item on the previous page. */
   occurredAt: string;
   /** Row id of the last item on the previous page (tiebreaker). */
   id: string;
}

export const ReferralTierSnapshotSchema = z.object({
   wallet: z.string(),
   /** Current referral tier (1, 2 or 3). */
   tier: z.number().int(),
   /** Cumulative referred volume in XLM. */
   cumulativeVolume: z.number(),
   /** Volume threshold required for the next tier, or null at the top tier. */
   nextThreshold: z.number().nullable(),
   /** Additional volume needed to reach the next tier, or null at the top. */
   distanceToNextThreshold: z.number().nullable(),
   /** Reward rate (basis points) applied at the current tier. */
   rewardRateBps: z.number().int(),
   /** When the wallet last upgraded tiers (ISO timestamp), if ever. */
   updatedAt: z.string().nullable(),
});

export type ReferralTierSnapshot = z.infer<typeof ReferralTierSnapshotSchema>;

export const ReferralTierHistoryItemSchema = z.object({
   id: z.string(),
   previousTier: z.number().int(),
   newTier: z.number().int(),
   cumulativeVolume: z.number(),
   occurredAt: z.string(),
   txHash: z.string(),
});

export type ReferralTierHistoryItem = z.infer<
   typeof ReferralTierHistoryItemSchema
>;

export interface ReferralTierHistoryPage {
   items: ReferralTierHistoryItem[];
   pagination: {
      limit: number;
      hasMore: boolean;
      nextCursor?: string;
   };
}
