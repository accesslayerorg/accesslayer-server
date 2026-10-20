// src/modules/staking/staking-epoch.schemas.ts
// Zod request/response schemas for the staking epoch REST endpoints (#1086).

import { z } from 'zod';
import {
   MAX_PAGE_SIZE,
   MIN_PAGE_SIZE,
} from '../../constants/pagination.constants';

export const DEFAULT_KEY_EPOCHS_PAGE_SIZE = 20;

// ── Query schemas ─────────────────────────────────────────────

/**
 * Query params for GET /staking/:wallet/positions
 *
 * `currentEpoch` is the caller-supplied epoch sequence used to compute
 * `epochsRemaining`. When omitted it defaults to 0 and `epochsRemaining`
 * will reflect the full lock duration remaining from epoch 0.
 */
export const PositionsQuerySchema = z
   .object({
      currentEpoch: z.coerce.number().int().min(0).optional().default(0),
   })
   .strict();

export type PositionsQuery = z.infer<typeof PositionsQuerySchema>;

/**
 * Query params for GET /staking/:wallet/positions/:stakeId
 * Same `currentEpoch` semantics as the list endpoint.
 */
export const PositionDetailQuerySchema = z
   .object({
      currentEpoch: z.coerce.number().int().min(0).optional().default(0),
   })
   .strict();

export type PositionDetailQuery = z.infer<typeof PositionDetailQuerySchema>;

/**
 * Query params for GET /keys/:keyId/epochs
 * Offset-based pagination matching the service layer.
 */
export const KeyEpochsQuerySchema = z
   .object({
      limit: z.coerce
         .number()
         .int()
         .min(MIN_PAGE_SIZE)
         .max(MAX_PAGE_SIZE)
         .optional()
         .default(DEFAULT_KEY_EPOCHS_PAGE_SIZE),
      offset: z.coerce.number().int().min(0).optional().default(0),
   })
   .strict();

export type KeyEpochsQuery = z.infer<typeof KeyEpochsQuerySchema>;

// ── Response item shapes ──────────────────────────────────────

export const StakePositionItemSchema = z.object({
   id: z.string(),
   wallet: z.string(),
   keyId: z.string(),
   amount: z.string(),
   startEpoch: z.number().int(),
   epochsTotal: z.number().int().nullable(),
   epochsRemaining: z.number().int().nullable(),
   accruedRewards: z.string(),
   createdAt: z.string(),
});

export type StakePositionItem = z.infer<typeof StakePositionItemSchema>;

export const EpochRewardItemSchema = z.object({
   epoch: z.number().int(),
   keyId: z.string(),
   totalDistributed: z.string(),
   distributedAt: z.string(),
});

export type EpochRewardItem = z.infer<typeof EpochRewardItemSchema>;

export const StakePositionDetailSchema = StakePositionItemSchema.extend({
   epochHistory: z.array(EpochRewardItemSchema),
});

export type StakePositionDetail = z.infer<typeof StakePositionDetailSchema>;
