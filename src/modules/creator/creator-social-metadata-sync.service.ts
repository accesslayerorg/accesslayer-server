// src/modules/creator/creator-social-metadata-sync.service.ts
//
// Social metadata sync service for creator key profiles (#1037).
//
// Responsibilities:
// - Indexes `SocialMetadataUpdated` events from the social metadata extension contract.
// - Resolves avatar CIDs to Pinata IPFS gateway URLs on sync.
// - Syncs display name, bio, avatar URL, and social links (twitter, website, discord)
//   to the database (`CreatorProfile`) and API layer cache.
// - Invalidates creator profile, social, and key detail caches immediately (well within 60s).
// - Serves `GET /creators/:wallet/social` with display name, bio, avatar URL, and social links.

import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { resolvePinataGatewayUrl } from '../keys/key-metadata-sync.service';
import { normalizeSocialLinkUrl } from './creator-social-link-url.utils';
import { sanitizeDisplayName } from './creator-display-name-sanitize.utils';
import { sanitizeBio } from './creator-bio-sanitize.utils';
import { truncateString } from '../../utils/string-truncate.utils';
import {
   cacheGetJson,
   cacheSetJson,
   cacheInvalidate,
} from '../../utils/redis.utils';
import { resetCreatorListCache } from '../creators/creators.cache';
import {
   processIndexerChainEvents,
   IndexerChainEvent,
} from '../../utils/indexer-event-processor.utils';

export const CREATOR_SOCIAL_CACHE_TTL_SECONDS = 60;

export class CreatorSocialProfileNotFoundError extends Error {
   constructor(identifier: string) {
      super(`Creator social profile not found for: ${identifier}`);
      this.name = 'CreatorSocialProfileNotFoundError';
   }
}

export interface CreatorSocialLinks {
   twitter: string | null;
   website: string | null;
   discord: string | null;
}

export interface CreatorSocialMetadataResponse {
   creatorId: string;
   keyId: string;
   handle: string;
   wallet: string | null;
   displayName: string;
   bio: string | null;
   avatarCid: string | null;
   avatarUrl: string | null;
   twitter: string | null;
   website: string | null;
   discord: string | null;
   socialLinks: CreatorSocialLinks;
   links: Array<{ label: string; url: string }>;
   updatedAt: string;
}

export interface SocialMetadataUpdatedEvent extends IndexerChainEvent {
   eventType: 'SocialMetadataUpdated' | 'SOCIAL_METADATA_UPDATED';
   keyId?: string;
   creatorId?: string;
   wallet?: string;
   handle?: string;
   displayName?: string | null;
   display_name?: string | null;
   bio?: string | null;
   avatarCid?: string | null;
   avatar_cid?: string | null;
   avatarUrl?: string | null;
   twitter?: string | null;
   website?: string | null;
   discord?: string | null;
   socialLinks?: Partial<CreatorSocialLinks>;
}

function safeNormalizeSocialUrl(url?: string | null): string | null {
   if (url === undefined || url === null) return null;
   const trimmed = String(url).trim();
   if (!trimmed) return null;
   try {
      return normalizeSocialLinkUrl(trimmed);
   } catch {
      return trimmed;
   }
}

function buildSocialLinksList(
   socialLinks: CreatorSocialLinks
): Array<{ label: string; url: string }> {
   const links: Array<{ label: string; url: string }> = [];
   if (socialLinks.twitter) {
      links.push({ label: 'Twitter', url: socialLinks.twitter });
   }
   if (socialLinks.website) {
      links.push({ label: 'Website', url: socialLinks.website });
   }
   if (socialLinks.discord) {
      links.push({ label: 'Discord', url: socialLinks.discord });
   }
   return links;
}

async function findCreatorProfileForSocial(identifier: string) {
   return prisma.creatorProfile.findFirst({
      where: {
         OR: [
            { id: identifier },
            { handle: identifier },
            { user: { stellarWallet: { address: identifier } } },
         ],
      },
      select: {
         id: true,
         handle: true,
         displayName: true,
         bio: true,
         avatarUrl: true,
         avatarCid: true,
         twitter: true,
         website: true,
         discord: true,
         updatedAt: true,
         user: {
            select: {
               stellarWallet: {
                  select: {
                     address: true,
                  },
               },
            },
         },
      },
   });
}

function formatSocialMetadataResponse(
   profile: NonNullable<Awaited<ReturnType<typeof findCreatorProfileForSocial>>>
): CreatorSocialMetadataResponse {
   const avatarCid = profile.avatarCid ?? null;
   const resolvedAvatarUrl =
      resolvePinataGatewayUrl(avatarCid) || profile.avatarUrl || null;
   const twitter = profile.twitter ?? null;
   const website = profile.website ?? null;
   const discord = profile.discord ?? null;
   const socialLinks: CreatorSocialLinks = { twitter, website, discord };
   const wallet = profile.user?.stellarWallet?.address ?? null;

   return {
      creatorId: profile.id,
      keyId: profile.id,
      handle: profile.handle,
      wallet,
      displayName: profile.displayName,
      bio: profile.bio ?? null,
      avatarCid,
      avatarUrl: resolvedAvatarUrl,
      twitter,
      website,
      discord,
      socialLinks,
      links: buildSocialLinksList(socialLinks),
      updatedAt:
         profile.updatedAt instanceof Date
            ? profile.updatedAt.toISOString()
            : new Date().toISOString(),
   };
}

/**
 * Invalidates all creator social, profile, and key detail caches for a creator (#1037).
 */
export async function invalidateCreatorSocialCaches(identifiers: {
   id?: string | null;
   handle?: string | null;
   wallet?: string | null;
   extraIdentifier?: string | null;
}): Promise<void> {
   const keys = Array.from(
      new Set(
         [
            identifiers.id ? `creator:social:${identifiers.id}` : null,
            identifiers.handle ? `creator:social:${identifiers.handle}` : null,
            identifiers.wallet ? `creator:social:${identifiers.wallet}` : null,
            identifiers.extraIdentifier
               ? `creator:social:${identifiers.extraIdentifier}`
               : null,
            identifiers.id ? `creator:profile:${identifiers.id}` : null,
            identifiers.handle ? `creator:profile:${identifiers.handle}` : null,
            identifiers.wallet ? `creator:profile:${identifiers.wallet}` : null,
            identifiers.extraIdentifier
               ? `creator:profile:${identifiers.extraIdentifier}`
               : null,
            identifiers.id ? `key-metadata:${identifiers.id}` : null,
            'creators:*',
            'creator:*',
         ].filter((k): k is string => Boolean(k))
      )
   );

   try {
      await cacheInvalidate(...keys);
   } catch {
      // Non-blocking if Redis is unavailable
   }
   resetCreatorListCache();
}

/**
 * Reads social metadata for a creator / key by wallet, handle, or creator ID (#1037).
 *
 * Used by `GET /creators/:wallet/social`.
 */
export async function getCreatorSocialMetadata(
   identifier: string
): Promise<CreatorSocialMetadataResponse> {
   const trimmed = identifier.trim();
   const cacheKey = `creator:social:${trimmed}`;

   try {
      const cached =
         await cacheGetJson<CreatorSocialMetadataResponse>(cacheKey);
      if (cached) {
         return cached;
      }
   } catch {
      // Cache miss or unavailable
   }

   const profile = await findCreatorProfileForSocial(trimmed);
   if (!profile) {
      throw new CreatorSocialProfileNotFoundError(trimmed);
   }

   const response = formatSocialMetadataResponse(profile);

   try {
      await cacheSetJson(cacheKey, response, CREATOR_SOCIAL_CACHE_TTL_SECONDS);
   } catch {
      // Non-blocking cache write
   }

   return response;
}

/**
 * Synchronizes a creator key's social metadata from a `SocialMetadataUpdated`
 * contract event payload, resolves the avatar CID to a Pinata gateway URL,
 * persists to `CreatorProfile`, and invalidates all profile/social/key caches (#1037).
 */
export async function syncCreatorSocialMetadata(
   identifier: string,
   payload: {
      displayName?: string | null;
      display_name?: string | null;
      bio?: string | null;
      avatarCid?: string | null;
      avatar_cid?: string | null;
      avatarUrl?: string | null;
      twitter?: string | null;
      website?: string | null;
      discord?: string | null;
      socialLinks?: Partial<CreatorSocialLinks>;
   }
): Promise<CreatorSocialMetadataResponse> {
   const existing = await findCreatorProfileForSocial(identifier.trim());
   if (!existing) {
      throw new CreatorSocialProfileNotFoundError(identifier);
   }

   const rawDisplayName = payload.displayName ?? payload.display_name;
   const sanitizedName =
      rawDisplayName !== undefined && rawDisplayName !== null
         ? truncateString(sanitizeDisplayName(String(rawDisplayName)), 50)
         : undefined;

   const sanitizedBio =
      payload.bio !== undefined
         ? payload.bio === null
            ? null
            : truncateString(sanitizeBio(String(payload.bio)), 1000)
         : undefined;

   const hasAvatarCidField =
      payload.avatarCid !== undefined || payload.avatar_cid !== undefined;
   const rawAvatarCid = payload.avatarCid ?? payload.avatar_cid;
   const avatarCid = hasAvatarCidField
      ? rawAvatarCid
         ? String(rawAvatarCid).trim()
         : null
      : undefined;

   const resolvedAvatarUrl =
      avatarCid !== undefined
         ? resolvePinataGatewayUrl(avatarCid) || payload.avatarUrl || null
         : payload.avatarUrl !== undefined
           ? payload.avatarUrl
           : undefined;

   const rawTwitter =
      payload.twitter !== undefined
         ? payload.twitter
         : payload.socialLinks?.twitter;
   const rawWebsite =
      payload.website !== undefined
         ? payload.website
         : payload.socialLinks?.website;
   const rawDiscord =
      payload.discord !== undefined
         ? payload.discord
         : payload.socialLinks?.discord;

   const twitter =
      rawTwitter !== undefined ? safeNormalizeSocialUrl(rawTwitter) : undefined;
   const website =
      rawWebsite !== undefined ? safeNormalizeSocialUrl(rawWebsite) : undefined;
   const discord =
      rawDiscord !== undefined ? safeNormalizeSocialUrl(rawDiscord) : undefined;

   const updated = await prisma.creatorProfile.update({
      where: { id: existing.id },
      data: {
         ...(sanitizedName !== undefined && sanitizedName.length > 0
            ? { displayName: sanitizedName }
            : {}),
         ...(sanitizedBio !== undefined ? { bio: sanitizedBio } : {}),
         ...(avatarCid !== undefined ? { avatarCid } : {}),
         ...(resolvedAvatarUrl !== undefined
            ? { avatarUrl: resolvedAvatarUrl }
            : {}),
         ...(twitter !== undefined ? { twitter } : {}),
         ...(website !== undefined ? { website } : {}),
         ...(discord !== undefined ? { discord } : {}),
      },
   });

   const walletAddress = existing.user?.stellarWallet?.address ?? null;

   await invalidateCreatorSocialCaches({
      id: existing.id,
      handle: existing.handle,
      wallet: walletAddress,
      extraIdentifier: identifier.trim(),
   });

   const mergedProfile = {
      ...existing,
      ...updated,
      user: existing.user,
   };

   const response = formatSocialMetadataResponse(mergedProfile);

   logger.info(
      {
         type: 'creator_social_metadata_synced',
         creatorId: existing.id,
         handle: existing.handle,
         wallet: walletAddress,
         avatarCid: response.avatarCid,
         avatarUrl: response.avatarUrl,
      },
      'Creator social metadata synchronized and caches invalidated'
   );

   return response;
}

/**
 * Indexes `SocialMetadataUpdated` / `SOCIAL_METADATA_UPDATED` events emitted
 * by the social metadata extension contract (#1037).
 */
export async function processSocialMetadataUpdatedEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (
         event.eventType !== 'SocialMetadataUpdated' &&
         event.eventType !== 'SOCIAL_METADATA_UPDATED'
      ) {
         return;
      }

      const socialEvent = event as SocialMetadataUpdatedEvent;
      const identifier =
         socialEvent.keyId ||
         socialEvent.creatorId ||
         socialEvent.wallet ||
         socialEvent.handle;

      if (!identifier || typeof identifier !== 'string') {
         logger.warn(
            {
               type: 'social_metadata_event_invalid',
               eventId: `${event.txHash}:${event.eventIndex}`,
            },
            'Skipping SocialMetadataUpdated event with missing key/creator/wallet identifier'
         );
         return;
      }

      try {
         await syncCreatorSocialMetadata(identifier, {
            displayName: socialEvent.displayName ?? socialEvent.display_name,
            bio: socialEvent.bio,
            avatarCid: socialEvent.avatarCid ?? socialEvent.avatar_cid,
            avatarUrl: socialEvent.avatarUrl,
            twitter: socialEvent.twitter,
            website: socialEvent.website,
            discord: socialEvent.discord,
            socialLinks: socialEvent.socialLinks,
         });
      } catch (error) {
         if (error instanceof CreatorSocialProfileNotFoundError) {
            logger.warn(
               {
                  type: 'social_metadata_creator_not_found',
                  identifier,
                  eventId: `${event.txHash}:${event.eventIndex}`,
               },
               'SocialMetadataUpdated event references unknown creator key'
            );
            return;
         }
         throw error;
      }
   });
}
