import { z } from 'zod';
import { StellarAddressSchema } from '../wallet/wallet.schemas';

export const GetNonceQuerySchema = z.object({
   wallet: StellarAddressSchema,
});

export const ConsumeNonceBodySchema = z.object({
   wallet: StellarAddressSchema,
   nonce: z.number().int().nonnegative('nonce must be a non-negative integer'),
   action: z.string().min(1, 'action is required').max(128).optional(),
});

export const SignedActionWithNonceSchema = z.object({
   wallet: StellarAddressSchema,
   nonce: z.number().int().nonnegative('nonce must be a non-negative integer'),
   signature: z.string().min(1, 'signature is required').optional(),
});

export type GetNonceQuery = z.infer<typeof GetNonceQuerySchema>;
export type ConsumeNonceBody = z.infer<typeof ConsumeNonceBodySchema>;
export type SignedActionWithNonce = z.infer<typeof SignedActionWithNonceSchema>;
