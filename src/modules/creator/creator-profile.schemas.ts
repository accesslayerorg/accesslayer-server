import { z } from 'zod';
import { withCreatorSlugEmptyStringNormalization } from './creator-slug-input.utils';

/**
 * Shared creator profile identifier schema for route params.
 *
 * We use a conservative format now (UUID-like or CUID-like IDs can be added later)
 * and keep this centralized for future route extensions.
 */
export const CreatorProfileParamsSchema = z.object({
   creatorId: withCreatorSlugEmptyStringNormalization(
      z
         .string({ required_error: 'Creator ID is required' })
         .trim()
         .min(1, 'Creator ID is required')
         .max(128, 'Creator ID is too long')
   ),
});

/**
 * Placeholder read response shape for GET /api/v1/creators/:creatorId/profile.
 *
 * The shape is explicit now so future indexing-backed values can be dropped in
 * without changing API contracts.
 */
export const CreatorProfileReadResponseSchema = z.object({
   creatorId: z.string(),
   displayName: z.string().nullable(),
   bio: z.string().nullable(),
   avatarUrl: z.string().url().nullable(),
   links: z.array(z.object({ label: z.string(), url: z.string().url() })),
   metadata: z.object({
      source: z.enum(['placeholder']),
      isProfileComplete: z.boolean(),
   }),
});

/**
 * Placeholder write payload for PUT /api/v1/creators/:creatorId/profile.
 *
 * Validation is intentionally strict and explicit so the eventual persistence layer
 * can safely trust handler inputs.
 */
export const UpsertCreatorProfileBodySchema = z.object({
   displayName: z
      .string()
      .trim()
      .min(2, 'Display name must be at least 2 characters')
      .max(80, 'Display name must be at most 80 characters')
      .optional(),
   bio: z
      .string()
      .trim()
      .max(1000, 'Bio must be at most 1000 characters')
      .optional(),
   avatarUrl: z
      .string()
      .trim()
      .url('Avatar URL must be a valid URL')
      .optional(),
   links: z
      .array(
         z.object({
            label: z
               .string()
               .trim()
               .min(1, 'Link label is required')
               .max(40, 'Link label must be at most 40 characters'),
            url: z.string().trim().url('Link URL must be a valid URL'),
         })
      )
      .max(8, 'At most 8 profile links are allowed')
      .optional(),
});

export type CreatorProfileParams = z.infer<typeof CreatorProfileParamsSchema>;
export type CreatorProfileReadResponse = z.infer<
   typeof CreatorProfileReadResponseSchema
>;
export type UpsertCreatorProfileBody = z.infer<
   typeof UpsertCreatorProfileBodySchema
>;
