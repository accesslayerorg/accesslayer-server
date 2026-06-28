import type { CreatorProfile } from '../../types/profile.types';

/**
 * Builds a deterministic set of creator fixtures with evenly spaced timestamps.
 *
 * The helper is used by creator list integration tests that need stable
 * registration ordering without duplicating timestamp setup in each file.
 */
export function buildCreatorRegistrationFixtures(
   count: number,
   startTimestamp: string | Date,
   stepDays = 1
): CreatorProfile[] {
   const start = typeof startTimestamp === 'string' ? new Date(startTimestamp) : startTimestamp;
   const stepMs = stepDays * 24 * 60 * 60 * 1000;

   return Array.from({ length: count }, (_, index) => {
      const timestamp = new Date(start.getTime() + index * stepMs);

      return {
         id: `cuid-${index + 1}`,
         userId: `user-${index + 1}`,
         handle: `creator_${index + 1}`,
         displayName: `Creator ${index + 1}`,
         isVerified: index % 2 === 0,
         createdAt: timestamp,
         updatedAt: timestamp,
      };
   });
}
