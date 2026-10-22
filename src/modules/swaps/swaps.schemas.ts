// src/modules/swaps/swaps.schemas.ts
// Zod validation schemas for atomic swap API endpoints (#1087)

import { z } from 'zod';

export const SwapWalletParamSchema = z.object({
   wallet: z.string().trim().min(1, 'Wallet address is required'),
});

export const SwapIdParamSchema = z.object({
   swap_id: z.string().trim().min(1, 'Swap ID is required'),
});

export const SwapsQuerySchema = z.object({
   page: z.coerce
      .number()
      .int()
      .positive('Page must be a positive integer')
      .optional()
      .default(1),
   limit: z.coerce
      .number()
      .int()
      .positive('Limit must be a positive integer')
      .max(100, 'Limit cannot exceed 100')
      .optional()
      .default(20),
   offset: z.coerce
      .number()
      .int()
      .nonnegative('Offset cannot be negative')
      .optional()
      .default(0),
   status: z.string().trim().optional(),
});

export type SwapsQuery = z.infer<typeof SwapsQuerySchema>;
