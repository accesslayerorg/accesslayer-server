// src/modules/creator/creator-proposals.schemas.ts
import { z } from 'zod';

export const VALID_PROPOSAL_DURATIONS = [1, 3, 7, 14] as const;

export const createProposalSchema = z.object({
   title: z
      .string({ required_error: 'Title is required' })
      .trim()
      .min(1, 'Title cannot be empty'),
   options: z
      .array(
         z
            .string({ required_error: 'Option is required' })
            .trim()
            .min(1, 'Option cannot be empty'),
         { required_error: 'Options are required' }
      )
      .min(2, 'Must provide at least 2 options')
      .max(4, 'Must provide at most 4 options'),
   durationDays: z
      .number({ required_error: 'durationDays is required' })
      .int('durationDays must be an integer')
      .refine(
         (val): val is (typeof VALID_PROPOSAL_DURATIONS)[number] =>
            VALID_PROPOSAL_DURATIONS.includes(val as any),
         {
            message: 'durationDays must be 1, 3, 7, or 14',
         }
      ),
});

export type CreateProposalInput = z.infer<typeof createProposalSchema>;
