// src/modules/relay/relay.schemas.ts
import { z } from 'zod';
import { StellarAddressSchema } from '../wallet/wallet.schemas';

export const RelayNonceParamsSchema = z.object({
   wallet: StellarAddressSchema,
});

export type RelayNonceParams = z.infer<typeof RelayNonceParamsSchema>;

export const RelaySubmitBodySchema = z.object({
   wallet: StellarAddressSchema,
   nonce: z
      .number({ required_error: 'nonce is required' })
      .int('nonce must be an integer')
      .nonnegative('nonce must be a non-negative integer'),
   signature: z
      .string({ required_error: 'signature is required' })
      .min(1, 'signature cannot be empty'),
   tx_params: z
      .string({ required_error: 'tx_params is required' })
      .min(1, 'tx_params cannot be empty'),
});

export type RelaySubmitBody = z.infer<typeof RelaySubmitBodySchema>;
