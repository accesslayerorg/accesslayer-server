import { z } from 'zod';

/**
 * Coerce a numeric input (string or number) into a decimal string and reject
 * non-finite / unsafe values. Mirrors the price handling used elsewhere in
 * the codebase (amounts are strings to preserve precision).
 */
export const DecimalInput = z
   .union([z.string(), z.number()])
   .transform(val => String(val).trim())
   .refine(val => val.length > 0, 'Value is required')
   .refine(val => {
      const n = Number(val);
      return Number.isFinite(n);
   }, 'Value must be a finite number');

/** A category label: non-empty, bounded length. */
export const CategoryInput = z
   .string()
   .min(1, 'Category is required')
   .max(100, 'Category must not exceed 100 characters')
   .trim();

/** Minimum rating: optional, 0 to 5 inclusive. Null means no rating floor. */
export const MinRatingInput = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((val) => {
    if (val === undefined || val === null || val === '') return null;
    const n = Number(val);
    if (!Number.isFinite(n) || n < 0 || n > 5)
      throw new Error('minRating must be between 0 and 5');
    return n;
  });

/** Maximum price per key in XLM: required, positive, 7 decimal places. */
export const MaxPriceInput = DecimalInput.refine(val => {
   const n = Number(val);
   return Number.isFinite(n) && n > 0;
}, 'maxPrice must be a positive number');

/** Maximum keys to purchase per listing under one rule: optional, default 1. */
export const MaxPerKeyInput = z
   .union([z.string(), z.number()])
   .transform(val => {
      const n = typeof val === 'number' ? val : Number(val);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
         throw new Error('maxPerKey must be a positive integer');
      }
      return n;
   })
   .optional()
   .default(1);

export const CreateAutoInvestRuleSchema = z.object({
   category: CategoryInput,
   minRating: MinRatingInput,
   maxPrice: MaxPriceInput,
   maxPerKey: MaxPerKeyInput,
});

export type CreateAutoInvestRuleInput = z.infer<
   typeof CreateAutoInvestRuleSchema
>;

export const UpdateAutoInvestRuleSchema =
   CreateAutoInvestRuleSchema.partial().extend({
      isActive: z.boolean().optional(),
   });

export type UpdateAutoInvestRuleInput = z.infer<
   typeof UpdateAutoInvestRuleSchema
>;

export const AutoInvestRuleQuerySchema = z.object({
   wallet: z
      .string()
      .min(1, 'wallet query parameter is required')
      .refine(
         val => /^G[A-Z2-7]{55}$/.test(val),
         'wallet must be a valid Stellar address'
      ),
});

export type AutoInvestRuleQuery = z.infer<typeof AutoInvestRuleQuerySchema>;

export const AutoInvestRuleParamsSchema = z.object({
   id: z.string().cuid('Invalid rule ID format'),
});

export type AutoInvestRuleParams = z.infer<typeof AutoInvestRuleParamsSchema>;

export interface AutoInvestRuleRow {
   id: string;
   walletAddress: string;
   category: string;
   minRating: string | null;
   maxPrice: string;
   maxPerKey: number;
   isActive: boolean;
   createdAt: Date;
   updatedAt: Date;
}

/** Serializes a Prisma rule row (Decimal fields) into plain strings. */
export function serializeRule(row: {
   id: string;
   walletAddress: string;
   category: string;
   minRating: unknown;
   maxPrice: unknown;
   maxPerKey: number;
   isActive: boolean;
   createdAt: Date;
   updatedAt: Date;
}): AutoInvestRuleRow {
   return {
      id: row.id,
      walletAddress: row.walletAddress,
      category: row.category,
      minRating:
         row.minRating === null || row.minRating === undefined
            ? null
            : String(row.minRating),
      maxPrice: String(row.maxPrice),
      maxPerKey: row.maxPerKey,
      isActive: row.isActive,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
   };
}

export interface AutoInvestExecutionRow {
   id: string;
   ruleId: string;
   listingId: string;
   status: string;
   transactionHash: string | null;
   createdAt: Date;
   updatedAt: Date;
}
