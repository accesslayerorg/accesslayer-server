import { z } from 'zod';

export const BalanceHistoryQuerySchema = z
   .object({
      keyId: z.string().min(1, 'keyId is required'),
      from: z.coerce.number().int().min(0).optional(),
      to: z.coerce.number().int().min(0).optional(),
   })
   .refine(
      (data) =>
         data.from === undefined ||
         data.to === undefined ||
         data.from <= data.to,
      { message: 'from must be less than or equal to to', path: ['from'] }
   );

export const PortfolioAsOfQuerySchema = z.object({
   asOf: z
      .string()
      .min(1, 'asOf ISO date is required')
      .refine((val) => !Number.isNaN(Date.parse(val)), {
         message: 'asOf must be a valid ISO date',
      }),
});
