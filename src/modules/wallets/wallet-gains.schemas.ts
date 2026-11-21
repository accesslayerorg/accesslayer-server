import { z } from 'zod';
import { isValidStellarAddress } from '../wallet/wallet.utils';

/**
 * Validated with Stellar StrKey (format and checksum), not just a regex, so a
 * mistyped address is rejected rather than returning an empty report.
 */
export const WalletGainsParamsSchema = z.object({
   address: z
      .string()
      .refine(isValidStellarAddress, {
         message: 'Invalid Stellar wallet address',
      }),
});

/** `year` is required and must be exactly four digits, e.g. `2026`. */
export const WalletGainsQuerySchema = z.object({
   year: z
      .string({ required_error: 'Year is required' })
      .regex(/^\d{4}$/, 'Year must be a 4-digit integer')
      .transform(Number),
});
