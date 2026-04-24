import { prisma } from '../../utils/prisma.utils';
import {
   CreatorProfileReadResponse,
   UpsertCreatorProfileBody,
} from './creator-profile.schemas';

/**
 * Get creator profile by handle.
 * Throws an error if creator is not found.
 */
export async function getCreatorProfile(
   creatorId: string
): Promise<CreatorProfileReadResponse> {
   // Check if creator exists
   const creator = await prisma.creatorProfile.findUnique({
      where: { handle: creatorId },
   });

   if (!creator) {
      throw new Error('Creator not found');
   }

   // TODO(accesslayer): Replace with actual profile data when ready
   return {
      creatorId,
      displayName: creator.displayName,
      bio: creator.bio,
      avatarUrl: creator.avatarUrl,
      links: [], // TODO: Add links when schema supports
      metadata: {
         source: 'database',
         isProfileComplete: Boolean(creator.displayName && creator.bio),
      },
   };
}

/**
 * Placeholder profile upsert service.
 *
 * TODO(accesslayer): Wire this to authenticated profile persistence when
 * creator identity and ownership rules are finalized.
 */
export async function upsertCreatorProfile(
   creatorId: string,
   payload: UpsertCreatorProfileBody
): Promise<{
   creatorId: string;
   acceptedProfile: UpsertCreatorProfileBody;
   metadata: { source: 'placeholder'; persisted: false };
}> {
   return {
      creatorId,
      acceptedProfile: payload,
      metadata: {
         source: 'placeholder',
         persisted: false,
      },
   };
}
