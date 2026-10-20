import { z } from 'zod';

export const SubmitTradeSchema = z.object({
   operation: z.enum(['buy', 'sell', 'BUY', 'SELL']),
   wallet: z.string().min(1, 'Wallet address is required'),
   creatorWallet: z.string().min(1, 'Creator wallet address is required'),
   amount: z.union([
      z.number().positive('Amount must be positive'),
      z.string().regex(/^\d+(\.\d+)?$/, 'Amount must be a positive number'),
   ]),
   expectedSupplyBefore: z.union([
      z.number().nonnegative('Expected supply must be non-negative'),
      z.string().regex(/^\d+(\.\d+)?$/, 'Expected supply must be non-negative'),
   ]),
   xdrPayload: z.string().min(1, 'XDR payload is required'),
   idempotencyKey: z.string().optional(),
});

export type SubmitTradeInput = z.infer<typeof SubmitTradeSchema>;

export const GetWALEntryParamSchema = z.object({
   idOrTxHash: z.string().min(1, 'ID or txHash is required'),
});

export const TriggerRecoverySchema = z.object({
   ageThresholdMs: z.coerce.number().int().positive().optional(),
   maxPollAttempts: z.coerce.number().int().positive().optional(),
});
