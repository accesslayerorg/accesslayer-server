import { z } from 'zod';

export const CreateOrderSchema = z.preprocess(
   val => {
      if (
         val &&
         typeof val === 'object' &&
         !('targetPrice' in val) &&
         'price' in val
      ) {
         return { ...val, targetPrice: (val as any).price };
      }
      return val;
   },
   z.object({
      keyId: z.string().min(1, 'keyId is required'),
      side: z
         .string()
         .transform(value => value.toUpperCase())
         .pipe(
            z.enum(['BUY', 'SELL'], {
               errorMap: () => ({ message: "side must be 'buy' or 'sell'" }),
            })
         ),
      targetPrice: z
         .number({ invalid_type_error: 'targetPrice must be a number' })
         .positive('targetPrice must be positive')
         .finite('targetPrice must be finite'),
      quantity: z
         .number({ invalid_type_error: 'quantity must be a number' })
         .positive('quantity must be positive')
         .finite('quantity must be finite'),
      expiresAt: z
         .coerce.date()
         .refine(date => date.getTime() > Date.now(), {
            message: 'expiresAt must be in the future',
         })
         .optional(),
   })
);

export type CreateOrderInput = z.infer<typeof CreateOrderSchema>;
export type OrderSide = CreateOrderInput['side'];
