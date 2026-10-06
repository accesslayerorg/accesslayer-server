import { z } from 'zod';

export const EscalatingProposalsQuerySchema = z
   .object({
      cursor: z.string().optional(),
   })
   .strict();

export type EscalatingProposalsQueryType = z.infer<
   typeof EscalatingProposalsQuerySchema
>;
