import { z } from 'zod';

/**
 * Validation schema for GET /keys/:keyId/whitelist query parameters.
 */
export const GetWhitelistStatusQuerySchema = z.object({
   wallet: z
      .string()
      .min(1, 'Wallet address is required')
      .max(100, 'Invalid wallet address format'),
});

export type GetWhitelistStatusQuery = z.infer<
   typeof GetWhitelistStatusQuerySchema
>;

/**
 * Response schema for whitelist status.
 */
export const WhitelistStatusResponseSchema = z.object({
   whitelistEnabled: z.boolean(),
   isApproved: z.boolean(),
});

export type WhitelistStatusResponse = z.infer<
   typeof WhitelistStatusResponseSchema
>;
