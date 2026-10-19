// src/modules/nonce/nonce.schemas.ts
import { z } from 'zod';
import { StellarAddressSchema } from '../wallet/wallet.schemas';

export const GetNonceQuerySchema = z.object({
   wallet: StellarAddressSchema,
});

export type GetNonceQuery = z.infer<typeof GetNonceQuerySchema>;

export const ConsumeNonceBodySchema = z.object({
   wallet: StellarAddressSchema,
   nonce: z
      .number({ required_error: 'nonce is required' })
      .int('nonce must be an integer')
      .nonnegative('nonce must be a non-negative integer'),
   action: z.string().trim().min(1, 'action cannot be empty').optional(),
});

export type ConsumeNonceBody = z.infer<typeof ConsumeNonceBodySchema>;
