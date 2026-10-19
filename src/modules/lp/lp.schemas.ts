import { z } from 'zod';

export const LpPositionsByWalletQuerySchema = z
   .object({
      wallet: z.string().trim().min(1, 'wallet is required'),
   })
   .strict();

export type LpPositionsByWalletQueryType = z.infer<
   typeof LpPositionsByWalletQuerySchema
>;

export const LpPositionsByWalletParamsSchema = z
   .object({
      wallet: z.string().trim().min(1, 'wallet is required'),
   })
   .strict();

export type LpPositionsByWalletParamsType = z.infer<
   typeof LpPositionsByWalletParamsSchema
>;

export const LpPositionDetailParamsSchema = z
   .object({
      wallet: z.string().trim().min(1, 'wallet is required'),
      positionId: z.string().trim().min(1, 'positionId is required'),
   })
   .strict();

export type LpPositionDetailParamsType = z.infer<
   typeof LpPositionDetailParamsSchema
>;
