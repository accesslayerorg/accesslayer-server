import {
   CreatorProfileReadResponse,
   UpsertCreatorProfileBody,
} from './creator-profile.schemas';

/**
 * Placeholder profile read service.
 *
 * TODO(accesslayer): Replace this placeholder source with database/indexing-backed
 * reads in a follow-up issue.
 */
export async function getCreatorProfile(
   creatorId: string
): Promise<CreatorProfileReadResponse> {
   return {
      creatorId,
      displayName: null,
      bio: null,
      avatarUrl: null,
      links: [],
      metadata: {
         source: 'placeholder',
         isProfileComplete: false,
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
