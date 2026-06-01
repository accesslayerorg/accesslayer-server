import { prisma } from './prisma.utils';
import { CreatorProfile } from '../types/profile.types';

// Fields matching the `CreatorProfile` type stored in the DB
const CREATOR_PROFILE_SELECT = {
   id: true,
   userId: true,
   handle: true,
   displayName: true,
   bio: true,
   avatarUrl: true,
   perkSummary: true,
   isVerified: true,
   createdAt: true,
   updatedAt: true,
};

/**
 * Fetch multiple creator profiles in a single query and return results in the
 * same order as the provided `ids` array. Missing records are returned as
 * `null` in their input position.
 */
export async function fetchCreatorProfilesByIds(
   ids: string[]
): Promise<(CreatorProfile | null)[]> {
   if (!ids || ids.length === 0) return [];

   const records = await prisma.creatorProfile.findMany({
      where: { id: { in: ids } },
      select: CREATOR_PROFILE_SELECT,
   });

   const map = new Map<string, CreatorProfile>();
   records.forEach((r) => map.set(r.id, r as CreatorProfile));

   return ids.map((id) => map.get(id) ?? null);
}

export { CREATOR_PROFILE_SELECT };
