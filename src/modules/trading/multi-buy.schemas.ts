import { z } from 'zod';

const MultiBuyLegSchema = z.object({
   creator: z.string().min(1, 'Creator address is required'),
   amount: z.number().int().positive('Amount must be a positive integer'),
   max_price: z
      .string()
      .min(1, 'max_price is required')
      .refine(val => {
         try {
            return BigInt(val) > 0n;
         } catch {
            return false;
         }
      }, 'max_price must be a positive integer string'),
});

export const MultiBuyRequestSchema = z.object({
   buyer: z.string().min(1, 'Buyer address is required'),
   legs: z
      .array(MultiBuyLegSchema)
      .min(1, 'legs_empty')
      .max(10, 'too_many_legs'),
   global_deadline_ledger: z
      .number()
      .int()
      .positive('global_deadline_ledger must be a positive integer'),
});

export type MultiBuyLeg = z.infer<typeof MultiBuyLegSchema>;
export type MultiBuyRequest = z.infer<typeof MultiBuyRequestSchema>;

export interface MultiBuyResult {
   creator: string;
   amount: number;
   total_cost: string;
   new_supply: number;
}
