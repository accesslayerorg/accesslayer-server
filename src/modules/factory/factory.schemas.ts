import { z } from 'zod';

export const FactoryKeysByCreatorQuerySchema = z
   .object({
      creator: z.string().min(1, 'creator is required'),
   })
   .strict();

export type FactoryKeysByCreatorQueryType = z.infer<
   typeof FactoryKeysByCreatorQuerySchema
>;
