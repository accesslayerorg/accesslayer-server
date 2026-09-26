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

export type GetDividendClaimsQuery = z.infer<
   typeof GetDividendClaimsQuerySchema
>;

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
      .number({ required_error: 'totalAmount is required' })
      .positive('totalAmount must be a positive integer'),
});

export type CreateDividendDistributionInput = z.infer<
   typeof CreateDividendDistributionSchema
>;
