import { z } from 'zod';
import { withCreatorSlugEmptyStringNormalization } from './creator-slug-input.utils';
import { normalizeSocialLinkUrl } from './creator-social-link-url.utils';
import { sanitizeBio } from './creator-bio-sanitize.utils';
import { sanitizeDisplayName } from './creator-display-name-sanitize.utils';
import { CreatorSocialDataSchema } from '../creators/creator-social.schemas';

/**
 * Shared creator profile identifier schema for route params.
 *
 * We use a conservative format now (UUID-like or CUID-like IDs can be added later)
 * and keep this centralized for future route extensions.
 */
export const CreatorProfileParamsSchema = z.preprocess(
   (val: any) => {
      if (val && typeof val === 'object') {
         if (val.wallet !== undefined && val.creatorId === undefined) {
            return { ...val, creatorId: val.wallet };
         }
      }
      return val;
   },
   z.object({
      creatorId: withCreatorSlugEmptyStringNormalization(
         z
            .string({ required_error: 'Creator ID is required' })
            .trim()
            .min(1, 'Creator ID is required')
            .max(128, 'Creator ID is too long')
      ),
      wallet: withCreatorSlugEmptyStringNormalization(
         z
            .string()
            .trim()
            .min(1, 'Wallet or creator ID is required')
            .max(128, 'Wallet or creator ID is too long')
      ).optional(),
   })
);

/**
 * Validation schema for individual creator perks.
 */
export const CreatorPerkSchema = z.object({
   id: z.string().cuid().optional().or(z.string().uuid()),
   title: z.string().min(1, 'Title is required').max(100),
   description: z.string().min(1, 'Description is required').max(500),
   icon: z.string().optional(),
});

const socialUrlSchema = z
   .string()
   .trim()
   .url('Must be a valid URL')
   .transform(normalizeSocialLinkUrl);

/**
 * Placeholder read response shape for GET /api/v1/creators/:creatorId/profile.
 *
 * The shape is explicit now so future indexing-backed values can be dropped in
 * without changing API contracts.
 *
 * @see ../creators/creators.serializers.ts — module docblock for null vs absent
 *      field rules across creator list and detail responses.
 */
export const CreatorProfileReadResponseSchema = z.object({
   creatorId: z.string(),
   walletAddress: z.string().nullable().optional(),
   wallet: z.string().nullable().optional(),
   displayName: z.string().nullable(),
   bio: z.string().nullable(),
   avatarUrl: z.string().url().nullable(),
   avatarCid: z.string().nullable().optional(),
   avatar_cid: z.string().nullable().optional(),
   twitter: z.string().nullable().optional(),
   website: z.string().nullable().optional(),
   discord: z.string().nullable().optional(),
   socialLinks: z
      .object({
         twitter: z.string().nullable(),
         website: z.string().nullable(),
         discord: z.string().nullable(),
      })
      .optional(),
   createdAt: z.string().datetime().nullable(),
   updatedAt: z.string().datetime().nullable(),
   perks: z.array(CreatorPerkSchema).optional(),
   links: z.array(z.object({ label: z.string(), url: z.string().url() })),
   /**
    * Social metadata synced from SocialMetadataUpdated events.
    * null until the first event has been indexed for the creator.
    */
   social: CreatorSocialDataSchema.nullable(),
   /** Whether trading is temporarily paused for this key by an admin. */
   tradingPaused: z.boolean(),
   /** Current milestone tier reached by supply. */
   currentMilestone: z.number(),
   /** Number of times the bonding curve was reset. */
   relaunchCount: z.number(),
   /** Current key price in stroops as a string. null when no trade has occurred. */
   currentPrice: z.string().nullable(),
   /** Price 24 h ago in stroops as a string. null when no baseline exists. */
   price24hAgo: z.string().nullable(),
   /** Computed percentage change. null when no baseline exists. */
   priceChange24h: z.number().nullable(),
   /** Whether this key was deployed through the on-chain key factory (#983). */
   is_factory_key: z.boolean(),
   metadata: z.object({
      source: z.enum(['placeholder', 'database']),
      isProfileComplete: z.boolean(),
   }),
});

/**
 * Write payload for PUT /api/v1/creators/:wallet/profile.
 *
 * Validation is intentionally strict and explicit so the persistence layer
 * can safely trust handler inputs.
 */
export const UpsertCreatorProfileBodySchema = z.object({
   displayName: z
      .string()
      .transform(sanitizeDisplayName)
      .refine(val => val.length > 0, { message: 'display_name_empty' })
      .refine(val => val.length <= 50, { message: 'display_name_too_long' })
      .optional(),
   display_name: z
      .string()
      .transform(sanitizeDisplayName)
      .refine(val => val.length > 0, { message: 'display_name_empty' })
      .refine(val => val.length <= 50, { message: 'display_name_too_long' })
      .optional(),
   bio: z
      .string()
      .trim()
      .max(1000, 'Bio must be at most 1000 characters')
      .transform(sanitizeBio)
      .optional(),
   avatarUrl: z
      .string()
      .trim()
      .url('Avatar URL must be a valid URL')
      .optional()
      .nullable(),
   avatarCid: z
      .string()
      .trim()
      .max(256, 'Avatar CID must be at most 256 characters')
      .optional()
      .nullable(),
   avatar_cid: z
      .string()
      .trim()
      .max(256, 'Avatar CID must be at most 256 characters')
      .optional()
      .nullable(),
   twitter: socialUrlSchema.optional().nullable(),
   website: socialUrlSchema.optional().nullable(),
   discord: socialUrlSchema.optional().nullable(),
   links: z
      .array(
         z.object({
            label: z
               .string()
               .trim()
               .min(1, 'Link label is required')
               .max(40, 'Link label must be at most 40 characters'),
            url: z
               .string()
               .trim()
               .url('Link URL must be a valid URL')
               .transform(normalizeSocialLinkUrl),
         })
      )
      .max(8, 'At most 8 profile links are allowed')
      .optional(),
   perks: z
      .array(CreatorPerkSchema)
      .max(10, 'At most 10 perks are allowed')
      .optional(),
   creatorRoyaltyBuyBps: z
      .number()
      .int()
      .min(0)
      .max(10000)
      .optional(),
   creatorRoyaltySellBps: z
      .number()
      .int()
      .min(0)
      .max(10000)
      .optional(),
});

export type CreatorProfileParams = z.infer<typeof CreatorProfileParamsSchema>;
export type CreatorProfileReadResponse = z.infer<
   typeof CreatorProfileReadResponseSchema
>;
export type UpsertCreatorProfileBody = z.infer<
   typeof UpsertCreatorProfileBodySchema
>;
