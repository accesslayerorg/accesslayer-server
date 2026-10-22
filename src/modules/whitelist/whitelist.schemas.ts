import { z } from 'zod';
import { StellarAddressSchema } from '../wallet/wallet.schemas';

/**
 * Validates a wallet address: must start with 'G' and be 30-70 alphanumeric chars.
 */
export const WalletAddressParamSchema = z
   .string()
   .min(1, 'Wallet address is required')
   .max(100, 'Invalid wallet address format')
   .regex(/^G[A-Za-z0-9]{30,70}$/, 'Invalid wallet address format');

/**
 * Validation schema for GET /keys/:keyId/whitelist query or path parameters.
 */
export const GetWhitelistStatusQuerySchema = z.object({
   wallet: WalletAddressParamSchema,
});

export type GetWhitelistStatusQuery = z.infer<
   typeof GetWhitelistStatusQuerySchema
>;

/**
 * Response schema for whitelist status.
 */
export const WhitelistStatusResponseSchema = z.object({
   is_whitelisted: z.boolean(),
   whitelist_mode_enabled: z.boolean(),
   whitelistEnabled: z.boolean().optional(),
   isApproved: z.boolean().optional(),
});

export type WhitelistStatusResponse = z.infer<
   typeof WhitelistStatusResponseSchema
>;

/** Max wallets accepted by one bulk-add or bulk-check request. */
export const WHITELIST_BULK_ADD_MAX = 100;

/**
 * Body for POST /keys/:key_id/whitelist/check.
 * Bulk checks whitelist status for up to 100 wallets.
 */
export const CheckWhitelistBodySchema = z.object({
   wallets: z
      .array(WalletAddressParamSchema)
      .min(1, 'At least one wallet is required')
      .max(
         WHITELIST_BULK_ADD_MAX,
         `At most ${WHITELIST_BULK_ADD_MAX} wallets can be checked per request`
      ),
});

export type CheckWhitelistBody = z.infer<typeof CheckWhitelistBodySchema>;

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
