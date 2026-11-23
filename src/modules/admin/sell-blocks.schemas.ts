import { z } from 'zod';
import { safeIntParam } from '../../utils/query.utils';

export const SELL_BLOCKS_DEFAULT_LIMIT = 50;
export const SELL_BLOCKS_MAX_LIMIT = 100;
const MAX_SUMMARY_WINDOW_HOURS = 24 * 365;

const windowParam = z
   .string()
   .regex(/^\d+(h|d)$/, 'Window must be expressed in hours or days')
   .default('24h')
   .refine(value => {
      const amount = Number.parseInt(value, 10);
      const hours = value.endsWith('d') ? amount * 24 : amount;
      return (
         Number.isSafeInteger(hours) &&
         hours > 0 &&
         hours <= MAX_SUMMARY_WINDOW_HOURS
      );
   }, 'Window must be between 1 hour and 365 days');

export const sellBlocksQuerySchema = z.object({
   wallet: z.string().trim().min(1).optional(),
   keyId: z.string().trim().min(1).optional(),
   cursor: z.string().trim().min(1).optional(),
   limit: safeIntParam({
      defaultValue: SELL_BLOCKS_DEFAULT_LIMIT,
      min: 1,
      max: SELL_BLOCKS_MAX_LIMIT,
      label: 'Limit',
   }),
});

export const sellBlocksSummaryQuerySchema = z.object({
   window: windowParam,
});

export type SellBlocksQuery = z.infer<typeof sellBlocksQuerySchema>;
export type SellBlocksSummaryQuery = z.infer<
   typeof sellBlocksSummaryQuerySchema
>;
