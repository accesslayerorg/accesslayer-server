import { z } from 'zod';

export const CreateOrderSchema = z.object({
   keyId: z.string().min(1, 'keyId is required'),
   quantity: z
      .union([z.number().positive(), z.string().regex(/^\d+(\.\d+)?$/)])
      .default(1),
   side: z.enum(['buy', 'sell']).default('buy'),
   price: z
      .union([z.number().positive(), z.string().regex(/^\d+(\.\d+)?$/)])
      .optional(),
});

export type CreateOrderInput = z.infer<typeof CreateOrderSchema>;
