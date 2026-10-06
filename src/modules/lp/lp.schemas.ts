import { z } from 'zod';

export const LpPositionsByWalletQuerySchema = z
   .object({
      wallet: z.string().min(1, 'wallet is required'),
   })
   .strict();

export type LpPositionsByWalletQueryType = z.infer<
   typeof LpPositionsByWalletQuerySchema
>;
