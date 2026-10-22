import { z } from 'zod';

export const TradesWalletParamSchema = z.object({
   wallet: z.string().trim().min(1, 'Wallet address is required'),
});

export type TradesWalletParam = z.infer<typeof TradesWalletParamSchema>;

const safeInt = (defaultValue: number, min = 0, max = 1000) =>
   z.preprocess(val => {
      if (val === undefined || val === null || val === '') return defaultValue;
      if (typeof val === 'number') return val;
      const parsed = Number(val);
      return isNaN(parsed) ? val : parsed;
   }, z.number().int().min(min).max(max));

export const TradesQuerySchema = z.object({
   limit: safeInt(20, 1, 100),
   offset: safeInt(0, 0, 1000000),
   page: safeInt(1, 1, 1000000).optional(),
   cursor: z.string().optional(),
   type: z.enum(['single', 'bundle', 'all']).optional(),
   from: z
      .string()
      .datetime({ message: 'from must be an ISO 8601 datetime string' })
      .optional(),
   to: z
      .string()
      .datetime({ message: 'to must be an ISO 8601 datetime string' })
      .optional(),
});

export type TradesQuery = z.infer<typeof TradesQuerySchema>;

export const BundleTradesQuerySchema = z.object({
   limit: safeInt(20, 1, 100),
   offset: safeInt(0, 0, 1000000),
   page: safeInt(1, 1, 1000000).optional(),
   cursor: z.string().optional(),
   from: z
      .string()
      .datetime({ message: 'from must be an ISO 8601 datetime string' })
      .optional(),
   to: z
      .string()
      .datetime({ message: 'to must be an ISO 8601 datetime string' })
      .optional(),
});

export type BundleTradesQuery = z.infer<typeof BundleTradesQuerySchema>;
