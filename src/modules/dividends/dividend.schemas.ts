import { z } from 'zod';

/**
 * Validation schema for GET /keys/:keyId/dividends query parameters.
 */
export const GetDividendDistributionsQuerySchema = z.object({
   limit: z.coerce.number().int().positive().max(100).optional().default(50),
   cursor: z.string().min(1).optional(),
});

export type GetDividendDistributionsQuery = z.infer<
   typeof GetDividendDistributionsQuerySchema
>;

/**
 * Validation schema for GET /keys/:keyId/dividends/:distributionId/holders query parameters.
 */
export const GetDividendClaimsQuerySchema = z.object({
   limit: z.coerce.number().int().positive().max(100).optional().default(50),
   cursor: z.string().min(1).optional(),
});

export type GetDividendClaimsQuery = z.infer<typeof GetDividendClaimsQuerySchema>;

/**
 * Response schema for a single dividend distribution.
 */
export const DividendDistributionResponseSchema = z.object({
   id: z.string(),
   creatorId: z.string(),
   distributionDate: z.string(), // ISO timestamp
   totalAmount: z.number(),
   holderCount: z.number(),
   perKeyAmount: z.number(),
});

export type DividendDistributionResponse = z.infer<
   typeof DividendDistributionResponseSchema
>;

/**
 * Response schema for dividend distributions list.
 */
export const DividendDistributionsListResponseSchema = z.object({
   entries: z.array(DividendDistributionResponseSchema),
   pagination: z.object({
      limit: z.number(),
      hasMore: z.boolean(),
      nextCursor: z.string().optional(),
   }),
});

/**
 * Response schema for a single dividend claim.
 */
export const DividendClaimResponseSchema = z.object({
   id: z.string(),
   recipientAddress: z.string(),
   amountXlm: z.number(),
   claimedAt: z.string().nullable().optional(),
});

export type DividendClaimResponse = z.infer<typeof DividendClaimResponseSchema>;

/**
 * Response schema for dividend claims list.
 */
export const DividendClaimsListResponseSchema = z.object({
   entries: z.array(DividendClaimResponseSchema),
   pagination: z.object({
      limit: z.number(),
      hasMore: z.boolean(),
      nextCursor: z.string().optional(),
   }),
});


export const CreateDividendDistributionSchema = z.object({
   totalAmount: z
      .number({ required_error: "totalAmount is required" })
      .positive("totalAmount must be a positive integer"),
});

export type CreateDividendDistributionInput = z.infer<
   typeof CreateDividendDistributionSchema
>;

/**
 * Validation schema for GET /holders/:wallet/dividends parameters.
 */
export const StellarWalletAddressRegex = /^G[A-Z2-7]{55}$/;

export const GetHolderDividendsParamsSchema = z.object({
   wallet: z
      .string()
      .trim()
      .regex(StellarWalletAddressRegex, 'Invalid Stellar wallet address'),
});

export type GetHolderDividendsParams = z.infer<
   typeof GetHolderDividendsParamsSchema
>;

/**
 * Per-key dividend summary in the holder aggregate response.
 */
export const HolderDividendKeyBreakdownSchema = z.object({
   keyId: z.string(),
   pending: z.number(),
   claimed: z.number(),
   total: z.number(),
   pendingAmount: z.number().optional(),
   claimedAmount: z.number().optional(),
   totalAmount: z.number().optional(),
});

export type HolderDividendKeyBreakdown = z.infer<
   typeof HolderDividendKeyBreakdownSchema
>;

/**
 * Response schema for GET /holders/:wallet/dividends.
 */
export const HolderDividendsResponseSchema = z.object({
   wallet: z.string(),
   totalPending: z.number(),
   totalClaimed: z.number(),
   total: z.number(),
   keys: z.array(HolderDividendKeyBreakdownSchema),
});

export type HolderDividendsResponse = z.infer<
   typeof HolderDividendsResponseSchema
>;

/**
 * Request body schema for POST /keys/:keyId/dividends/claim.
 */
export const ClaimDividendBodySchema = z.object({
   wallet: z
      .string()
      .trim()
      .regex(StellarWalletAddressRegex, 'Invalid Stellar wallet address')
      .optional(),
   claimant: z
      .string()
      .trim()
      .regex(StellarWalletAddressRegex, 'Invalid Stellar wallet address')
      .optional(),
});

export type ClaimDividendBody = z.infer<typeof ClaimDividendBodySchema>;

/**
 * Response schema for POST /keys/:keyId/dividends/claim.
 */
export const ClaimDividendResponseSchema = z.object({
   transaction: z.string(),
   transactionXdr: z.string().optional(),
   unsignedTransaction: z.string().optional(),
   networkPassphrase: z.string(),
   keyId: z.string(),
   claimantWallet: z.string(),
   pendingAmount: z.number().optional(),
});

export type ClaimDividendResponse = z.infer<
   typeof ClaimDividendResponseSchema
>;

