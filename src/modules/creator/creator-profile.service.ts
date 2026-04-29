import { prisma } from '../../utils/prisma.utils';
import {
   CreatorProfileReadResponse,
   UpsertCreatorProfileBody,
} from './creator-profile.schemas';
import { CREATOR_DETAIL_DEFAULT_SELECT } from '../../constants/creator-detail-include.constants';

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
      // Fallback for placeholder behavior if profile not found
      return {
         creatorId,
         displayName: null,
         bio: null,
         avatarUrl: null,
         perks: [],
         links: [],
         metadata: {
            source: 'placeholder',
            isProfileComplete: false,
         },
      };
   }

   return {
      creatorId: profile.id,
      displayName: profile.displayName,
      bio: profile.bio,
      avatarUrl: profile.avatarUrl,
      perks: (profile.perks as any) || [],
      links: [], // Links are not yet in the Prisma model, keeping as part of contract
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
   const profile = await prisma.creatorProfile.update({
      where: {
         id: creatorId,
      },
      data: {
         displayName: payload.displayName,
         bio: payload.bio,
         avatarUrl: payload.avatarUrl,
         perks: payload.perks as any,
      },
   });

   return {
      creatorId: profile.id,
      acceptedProfile: payload,
      metadata: {
         source: 'database',
         persisted: true,
      },
   };
}
