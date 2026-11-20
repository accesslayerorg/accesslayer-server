import { z } from 'zod';

const PROPOSAL_STATUSES = [
   'active',
   'passed',
   'failed',
   'quorum_not_met',
   'executed',
] as const;

/**
 * POST /governance/proposals
 *
 * `keyId` accepts a creator id or handle. `quorumBps` overrides the default
 * quorum threshold (30% = 3000 bps) for this proposal only.
 */
export const CreateGovernanceProposalSchema = z
   .object({
      keyId: z
         .string({ required_error: 'keyId is required' })
         .trim()
         .min(1, 'keyId cannot be empty'),
      title: z
         .string({ required_error: 'title is required' })
         .trim()
         .min(1, 'title cannot be empty')
         .max(200, 'title must be at most 200 characters'),
      options: z
         .array(z.string().trim().min(1, 'option cannot be empty'), {
            required_error: 'options are required',
         })
         .min(2, 'must provide at least 2 options')
         .max(8, 'must provide at most 8 options')
         .refine(
            options => new Set(options).size === options.length,
            'options must be unique'
         ),
      durationDays: z
         .number({ required_error: 'durationDays is required' })
         .int('durationDays must be an integer')
         .min(1, 'durationDays must be at least 1')
         .max(365, 'durationDays must be at most 365'),
      quorumBps: z
         .number()
         .int('quorumBps must be an integer')
         .min(0, 'quorumBps must be between 0 and 10000')
         .max(10000, 'quorumBps must be between 0 and 10000')
         .optional(),
      nonce: z
         .number()
         .int('nonce must be an integer')
         .nonnegative('nonce must be non-negative')
         .optional(),
   })
   .strict();

export type CreateGovernanceProposalInput = z.infer<
   typeof CreateGovernanceProposalSchema
>;

/** POST /governance/proposals/:id/vote */
export const CastGovernanceVoteSchema = z
   .object({
      optionIndex: z
         .number({ required_error: 'optionIndex is required' })
         .int('optionIndex must be an integer')
         .nonnegative('optionIndex must be non-negative'),
      nonce: z
         .number()
         .int('nonce must be an integer')
         .nonnegative('nonce must be non-negative')
         .optional(),
   })
   .strict();

export type CastGovernanceVoteInput = z.infer<typeof CastGovernanceVoteSchema>;

/** GET /governance/proposals */
export const ListGovernanceProposalsQuerySchema = z
   .object({
      status: z.enum(PROPOSAL_STATUSES).optional(),
      keyId: z.string().trim().min(1).optional(),
      cursor: z.string().trim().min(1).optional(),
   })
   .strict();

export type ListGovernanceProposalsQuery = z.infer<
   typeof ListGovernanceProposalsQuerySchema
>;
