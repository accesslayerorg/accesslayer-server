import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   CreatorProfileReadResponse,
   UpsertCreatorProfileBody,
} from './creator-profile.schemas';
import { CREATOR_DETAIL_DEFAULT_SELECT } from '../../constants/creator-detail-include.constants';
import { formatIsoTimestamp } from '../../utils/iso-timestamp.utils';
import { compute24hPriceChange } from '../../utils/price.utils';
import { normalizeSocialLinkUrl } from './creator-social-link-url.utils';
import { truncateToBytes } from '../../utils/string-truncate.utils';

const CREATOR_PROFILE_LIMITS = {
   displayName: 80,
   bio: 1000,
   linkLabel: 40,
   perkTitle: 100,
   perkDescription: 500,
} as const;

function normalizeProfileLinks(
   links: UpsertCreatorProfileBody['links']
): UpsertCreatorProfileBody['links'] {
   if (!links) {
      return links;
   }

   return links.map(link => ({
      ...link,
      label: truncateToBytes(link.label, CREATOR_PROFILE_LIMITS.linkLabel),
      url: normalizeSocialLinkUrl(link.url),
   }));
}

function normalizeProfilePerks(
   perks: UpsertCreatorProfileBody['perks']
): UpsertCreatorProfileBody['perks'] {
   if (!perks) {
      return perks;
   }

   return perks.map(perk => ({
      ...perk,
      title: truncateToBytes(perk.title, CREATOR_PROFILE_LIMITS.perkTitle),
      description: truncateToBytes(
         perk.description,
         CREATOR_PROFILE_LIMITS.perkDescription
      ),
   }));
}

function buildCreatorDetailCacheMissContext(creatorId: string) {
   return {
      event: 'creator_detail_cache_miss',
      creatorId,
      lookupKeys: ['id', 'handle'],
      source: 'creator-profile-service',
   };
}

/**
 * Reads a creator profile from the database.
 *
 * Checks both ID and handle to provide flexible lookup.
 */
export async function getCreatorProfile(
   creatorId: string
): Promise<CreatorProfileReadResponse> {
   const profile = await prisma.creatorProfile.findFirst({
      where: {
         OR: [{ id: creatorId }, { handle: creatorId }],
      },
      select: CREATOR_DETAIL_DEFAULT_SELECT,
   });

   if (!profile) {
      logger.warn(
         {
            ...buildCreatorDetailCacheMissContext(creatorId),
            type: 'creator_profile_cache_miss',
         },
         'Creator profile cache miss; returning placeholder response'
      );

      // Fallback for placeholder behavior if profile not found
      return {
         creatorId,
         displayName: null,
         bio: null,
         avatarUrl: null,
         createdAt: null,
         updatedAt: null,
         perks: [],
         links: [],
         currentPrice: null,
         price24hAgo: null,
         priceChange24h: null,
         metadata: {
            source: 'placeholder',
            isProfileComplete: false,
         },
      };
   }

   const snapshot = (profile as any).priceSnapshot as {
      currentPrice: bigint;
      price24hAgo: bigint;
      lastTradeAt: Date | null;
   } | null;

   let priceChange24h: number | null = null;
   if (snapshot) {
      priceChange24h = compute24hPriceChange(
         snapshot.currentPrice,
         snapshot.price24hAgo
      );
   }

   return {
      creatorId: profile.id,
      displayName: profile.displayName,
      bio: profile.bio,
      avatarUrl: profile.avatarUrl,
      createdAt: formatIsoTimestamp(profile.createdAt),
      updatedAt: formatIsoTimestamp(profile.updatedAt),
      perks: (profile.perks as any) || [],
      links: [], // Links are not yet in the Prisma model, keeping as part of contract
      currentPrice: snapshot ? snapshot.currentPrice.toString() : null,
      price24hAgo: snapshot ? snapshot.price24hAgo.toString() : null,
      priceChange24h,
      metadata: {
         source: 'database',
         isProfileComplete: !!profile.displayName && !!profile.bio,
      },
   };
}

/**
 * Upserts a creator profile in the database.
 *
 * This implementation persists validated payload fields including perks.
 */
export async function upsertCreatorProfile(
   creatorId: string,
   payload: UpsertCreatorProfileBody
): Promise<{
   creatorId: string;
   acceptedProfile: UpsertCreatorProfileBody;
   metadata: { source: 'database'; persisted: boolean };
}> {
   const normalizedPayload: UpsertCreatorProfileBody = {
      ...payload,
      displayName: payload.displayName
         ? truncateToBytes(
              payload.displayName,
              CREATOR_PROFILE_LIMITS.displayName
           )
         : payload.displayName,
      bio: payload.bio
         ? truncateToBytes(payload.bio, CREATOR_PROFILE_LIMITS.bio)
         : payload.bio,
      links: normalizeProfileLinks(payload.links),
      perks: normalizeProfilePerks(payload.perks),
   };

   const profile = await prisma.creatorProfile.update({
      where: {
         id: creatorId,
      },
      data: {
         displayName: normalizedPayload.displayName,
         bio: normalizedPayload.bio,
         avatarUrl: normalizedPayload.avatarUrl,
         perks: normalizedPayload.perks as any,
      },
   });

   return {
      creatorId: profile.id,
      acceptedProfile: normalizedPayload,
      metadata: {
         source: 'database',
         persisted: true,
      },
   };
}
