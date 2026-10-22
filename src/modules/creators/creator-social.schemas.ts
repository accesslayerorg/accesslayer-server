// src/modules/creators/creator-social.schemas.ts
//
// Response schemas for creator social metadata.
//
// Social metadata is synced from SocialMetadataUpdated events emitted by the
// social metadata extension contract. The shapes below are shared by:
// - GET /api/v1/creators/:wallet/social (full response, with creator identity)
// - GET /api/v1/creators/:id and GET /api/v1/creators/:id/profile
//   (the nullable `social` block embedded in creator detail responses)
//
// null vs absent rules (see creators.serializers.ts module docblock):
// - Optional scalars are present and null when unknown.
// - `links` is always an array; empty when no social links were synced.

import { z } from 'zod';

/**
 * A single social link (label + normalized URL).
 */
export const CreatorSocialLinkSchema = z.object({
   label: z.string(),
   url: z.string().url(),
});

/**
 * Provenance of the synced social metadata (the event it was synced from).
 */
export const CreatorSocialSourceSchema = z.object({
   ledger: z.number().int().nullable(),
   txHash: z.string().nullable(),
   eventIndex: z.number().int().nullable(),
});

/**
 * Social metadata for a creator, as synced from the extension contract.
 *
 * `synced` is false (and all values null / links empty) until the first
 * SocialMetadataUpdated event has been indexed for the creator.
 */
export const CreatorSocialDataSchema = z.object({
   displayName: z.string().nullable(),
   bio: z.string().nullable(),
   avatarUrl: z.string().url().nullable(),
   avatarCid: z.string().nullable(),
   links: z.array(CreatorSocialLinkSchema),
   synced: z.boolean(),
   updatedAt: z.string().datetime().nullable(),
   source: CreatorSocialSourceSchema.nullable(),
});

/**
 * Full response body for GET /api/v1/creators/:wallet/social.
 */
export const CreatorSocialResponseSchema = z.object({
   creatorId: z.string(),
   handle: z.string(),
   wallet: z.string().nullable(),
   displayName: z.string().nullable(),
   bio: z.string().nullable(),
   avatarUrl: z.string().url().nullable(),
   avatarCid: z.string().nullable(),
   links: z.array(CreatorSocialLinkSchema),
   synced: z.boolean(),
   updatedAt: z.string().datetime().nullable(),
   source: CreatorSocialSourceSchema.nullable(),
});

export type CreatorSocialLink = z.infer<typeof CreatorSocialLinkSchema>;
export type CreatorSocialSource = z.infer<typeof CreatorSocialSourceSchema>;
export type CreatorSocialData = z.infer<typeof CreatorSocialDataSchema>;
export type CreatorSocialResponse = z.infer<typeof CreatorSocialResponseSchema>;
