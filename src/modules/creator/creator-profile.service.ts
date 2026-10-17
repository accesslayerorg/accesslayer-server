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
import { truncateString } from '../../utils/string-truncate.utils';
import { computePriceChange } from '../../utils/price-change.utils';
import { sanitizeDisplayName } from './creator-display-name-sanitize.utils';
import {
   buildCreatorSocialData,
   getCreatorSocialSnapshot,
} from '../creators/creator-social.service';
import { invalidateKeyFeesCache } from '../keys/key-fees.service';
import { isFactoryKey } from '../factory/factory.service';
import { resolvePinataGatewayUrl } from '../keys/key-metadata-sync.service';
import {
   cacheGetJson,
   cacheSetJson,
   cacheInvalidate,
} from '../../utils/redis.utils';
import { resetCreatorListCache } from '../creators/creators.cache';

const CREATOR_PROFILE_LIMITS = {
   displayName: 50,
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
      label: truncateString(link.label, CREATOR_PROFILE_LIMITS.linkLabel),
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
      title: truncateString(perk.title, CREATOR_PROFILE_LIMITS.perkTitle),
      description: truncateString(
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

export async function creatorProfileExists(
   creatorId: string
): Promise<boolean> {
   const profile = await prisma.creatorProfile.findFirst({
      where: {
         OR: [{ id: creatorId }, { handle: creatorId }],
      },
      select: { id: true },
   });

   return profile !== null;
}

/**
 * Reads a creator profile from the database.
 *
 * Checks ID, handle, and wallet address to provide flexible lookup.
 */
export async function getCreatorProfile(
   creatorIdOrWallet: string
): Promise<CreatorProfileReadResponse> {
   const cacheKey = `creator:profile:${creatorIdOrWallet}`;
   try {
      const cached = await cacheGetJson<CreatorProfileReadResponse>(cacheKey);
      if (cached) {
         return cached;
      }
   } catch {
      // cache miss / unavailable
   }

   const profile = await prisma.creatorProfile.findFirst({
      where: {
         OR: [
            { id: creatorIdOrWallet },
            { handle: creatorIdOrWallet },
            { user: { stellarWallet: { address: creatorIdOrWallet } } },
         ],
      },
      select: CREATOR_DETAIL_DEFAULT_SELECT,
   });

   if (!profile) {
      logger.warn(
         {
            ...buildCreatorDetailCacheMissContext(creatorIdOrWallet),
            type: 'creator_profile_cache_miss',
         },
         'Creator profile cache miss; returning placeholder response'
      );

      // Fallback for placeholder behavior if profile not found
      return {
         creatorId: creatorIdOrWallet,
         displayName: null,
         bio: null,
         avatarUrl: null,
         createdAt: null,
         updatedAt: null,
         perks: [],
         links: [],
         social: null,
         tradingPaused: false,
         currentMilestone: 0,
         currentPrice: null,
         price24hAgo: null,
         priceChange24h: null,
         metadata: {
            source: 'placeholder',
            isProfileComplete: false,
         },
      } as any;
   }

   const snapshot = (profile as any).priceSnapshot as {
      currentPrice: bigint;
      price24hAgo: bigint;
      lastTradeAt: Date | null;
   } | null;

   const ONE_DAY_MS = 86_400_000;
   let priceChange24h: number | null = null;

   const [socialSnapshot, computedChange] = await Promise.all([
      getCreatorSocialSnapshot(profile.id),
      computePriceChange(profile.id, ONE_DAY_MS, prisma),
   ]);

   const social = buildCreatorSocialData(socialSnapshot);

   if (computedChange !== null) {
      priceChange24h = computedChange;
   } else if (snapshot) {
      priceChange24h = compute24hPriceChange(
         snapshot.currentPrice,
         snapshot.price24hAgo
      );
   }

   // #983: thread `is_factory_key` through the key summary.
   let is_factory_key = false;
   try {
      if ((prisma as any).factoryDeployedKey?.findUnique) {
         is_factory_key = await isFactoryKey(profile.id);
      }
   } catch {
      is_factory_key = false;
   }

   const avatarCid = (profile as any).avatarCid ?? null;
   const resolvedAvatarUrl =
      resolvePinataGatewayUrl(avatarCid) || profile.avatarUrl || null;
   const twitter = (profile as any).twitter ?? null;
   const website = (profile as any).website ?? null;
   const discord = (profile as any).discord ?? null;
   const walletAddress =
      (profile as any).user?.stellarWallet?.address ?? null;

   const links: Array<{ label: string; url: string }> = [];
   if (twitter) links.push({ label: 'Twitter', url: twitter });
   if (website) links.push({ label: 'Website', url: website });
   if (discord) links.push({ label: 'Discord', url: discord });

   const socialLinks = social?.links ?? [];

   const response: CreatorProfileReadResponse = {
      creatorId: profile.id,
      walletAddress,
      wallet: walletAddress,
      displayName: profile.displayName,
      bio: profile.bio,
      avatarUrl: resolvedAvatarUrl,
      avatarCid,
      avatar_cid: avatarCid,
      twitter,
      website,
      discord,
      socialLinks: { twitter, website, discord },
      createdAt: formatIsoTimestamp(profile.createdAt),
      updatedAt: formatIsoTimestamp(profile.updatedAt),
      perks: (profile.perks as any) || [],
      links: socialLinks.length > 0 ? socialLinks : links,
      social,
      tradingPaused: (profile as any).tradingPaused ?? false,
      currentMilestone: (profile as any).currentMilestone ?? 0,
      relaunchCount: (profile as any).relaunchCount ?? 0,
      currentPrice: snapshot ? snapshot.currentPrice.toString() : null,
      price24hAgo: snapshot ? snapshot.price24hAgo.toString() : null,
      priceChange24h,
      is_factory_key,
      metadata: {
         source: 'database',
         isProfileComplete: !!profile.displayName && !!profile.bio,
      },
   };

   try {
      await cacheSetJson(cacheKey, response, 300);
   } catch {
      // cache set non-blocking
   }

   return response;
}

/**
 * Upserts a creator profile in the database.
 *
 * This implementation persists validated payload fields including social links and avatar CID,
 * immediately invalidates profile and creator caches, and resolves avatar CIDs to Pinata URLs.
 */
export async function upsertCreatorProfile(
   creatorIdOrWallet: string,
   payload: UpsertCreatorProfileBody
): Promise<any> {
   const existing = await prisma.creatorProfile.findFirst({
      where: {
         OR: [
            { id: creatorIdOrWallet },
            { handle: creatorIdOrWallet },
            { user: { stellarWallet: { address: creatorIdOrWallet } } },
         ],
      },
      select: {
         id: true,
         handle: true,
         user: {
            select: {
               stellarWallet: {
                  select: { address: true },
               },
            },
         },
      },
   });

   const targetId = existing?.id ?? creatorIdOrWallet;

   const rawDisplayName = payload.displayName ?? payload.display_name;
   const sanitizedName = rawDisplayName !== undefined
      ? truncateString(
           sanitizeDisplayName(rawDisplayName),
           CREATOR_PROFILE_LIMITS.displayName
        )
      : undefined;

   const avatarCid = payload.avatar_cid ?? payload.avatarCid;
   let avatarUrl = payload.avatarUrl;
   if (avatarCid) {
      avatarUrl = resolvePinataGatewayUrl(avatarCid) || avatarUrl;
   }

   const normalizedPayload: UpsertCreatorProfileBody = {
      ...payload,
   };

   if (sanitizedName !== undefined) {
      if (payload.displayName !== undefined) {
         normalizedPayload.displayName = sanitizedName;
      }
      if (payload.display_name !== undefined) {
         normalizedPayload.display_name = sanitizedName;
      }
      if (payload.displayName === undefined && payload.display_name === undefined) {
         normalizedPayload.displayName = sanitizedName;
      }
   }

   if (payload.bio !== undefined) {
      normalizedPayload.bio = truncateString(payload.bio, CREATOR_PROFILE_LIMITS.bio);
   }

   if (avatarCid !== undefined) {
      if (payload.avatar_cid !== undefined) normalizedPayload.avatar_cid = avatarCid;
      if (payload.avatarCid !== undefined) normalizedPayload.avatarCid = avatarCid;
   }

   if (avatarUrl !== undefined) {
      normalizedPayload.avatarUrl = avatarUrl;
   }

   if (payload.links !== undefined) {
      normalizedPayload.links = normalizeProfileLinks(payload.links);
   }

   if (payload.perks !== undefined) {
      normalizedPayload.perks = normalizeProfilePerks(payload.perks);
   }

   const profile = await prisma.creatorProfile.update({
      where: {
         id: targetId,
      },
      data: {
         ...(sanitizedName !== undefined ? { displayName: sanitizedName } : {}),
         ...(normalizedPayload.bio !== undefined ? { bio: normalizedPayload.bio } : {}),
         ...(avatarCid !== undefined ? { avatarCid } : {}),
         ...(avatarUrl !== undefined ? { avatarUrl } : {}),
         ...(payload.twitter !== undefined ? { twitter: payload.twitter } : {}),
         ...(payload.website !== undefined ? { website: payload.website } : {}),
         ...(payload.discord !== undefined ? { discord: payload.discord } : {}),
         ...(normalizedPayload.perks !== undefined
            ? { perks: normalizedPayload.perks as any }
            : {}),
         ...(normalizedPayload.creatorRoyaltyBuyBps !== undefined
            ? { creatorRoyaltyBuyBps: normalizedPayload.creatorRoyaltyBuyBps }
            : {}),
         ...(normalizedPayload.creatorRoyaltySellBps !== undefined
            ? { creatorRoyaltySellBps: normalizedPayload.creatorRoyaltySellBps }
            : {}),
      },
   });

   // Cache invalidated immediately on update (#1016)
   const walletAddress = existing?.user?.stellarWallet?.address;
   const keysToInvalidate = Array.from(
      new Set(
         [
            profile?.id ? `creator:profile:${profile.id}` : null,
            profile?.handle ? `creator:profile:${profile.handle}` : null,
            existing?.handle ? `creator:profile:${existing.handle}` : null,
            creatorIdOrWallet ? `creator:profile:${creatorIdOrWallet}` : null,
            walletAddress ? `creator:profile:${walletAddress}` : null,
            'creators:*',
            'creator:*',
         ].filter((k): k is string => Boolean(k))
      )
   );
   try {
      await cacheInvalidate(...keysToInvalidate);
   } catch {
      // cache invalidation non-blocking
   }
   resetCreatorListCache();

   if (
      normalizedPayload.creatorRoyaltyBuyBps !== undefined ||
      normalizedPayload.creatorRoyaltySellBps !== undefined
   ) {
      await invalidateKeyFeesCache(profile.id);
   }

   return {
      creatorId: profile.id,
      acceptedProfile: normalizedPayload,
      metadata: {
         source: 'database',
         persisted: true,
      },
   };
}
