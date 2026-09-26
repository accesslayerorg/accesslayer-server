import { z } from 'zod';
import { StellarAddressSchema } from '../wallet/wallet.schemas';

/**
 * Validation schema for GET /keys/:keyId/whitelist query parameters.
 */
export const GetWhitelistStatusQuerySchema = z.object({
   wallet: z
      .string()
      .min(1, 'Wallet address is required')
      .max(100, 'Invalid wallet address format'),
});

export type GetWhitelistStatusQuery = z.infer<typeof GetWhitelistStatusQuerySchema>;

/**
 * Response schema for whitelist status.
 */
export const WhitelistStatusResponseSchema = z.object({
   whitelistEnabled: z.boolean(),
   isApproved: z.boolean(),
});

export type WhitelistStatusResponse = z.infer<typeof WhitelistStatusResponseSchema>;

/** Max wallets accepted by one bulk-add request. */
export const WHITELIST_BULK_ADD_MAX = 100;

/**
 * Body for POST /keys/:keyId/whitelist. Accepts an array so creators can
 * bulk-add; duplicates within the request are collapsed.
 */
export const AddWhitelistBodySchema = z.object({
   wallets: z
      .array(StellarAddressSchema)
      .min(1, 'At least one wallet is required')
      .max(
         WHITELIST_BULK_ADD_MAX,
         `At most ${WHITELIST_BULK_ADD_MAX} wallets can be added per request`
      )
      .transform(wallets => Array.from(new Set(wallets))),
});

export type AddWhitelistBody = z.infer<typeof AddWhitelistBodySchema>;

/** Params for DELETE /keys/:keyId/whitelist/:wallet. */
export const RemoveWhitelistParamsSchema = z.object({
   keyId: z.string().min(1),
   wallet: StellarAddressSchema,
});
