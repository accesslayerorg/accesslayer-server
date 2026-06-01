import { CreatorProfile } from '../../types/profile.types';

const CREATOR_FIXTURE_BASE_DATE = new Date(Date.UTC(2020, 0, 1));

/**
 * Generates a deterministic creator record from a numeric seed.
 *
 * Field mapping:
 * - id: `creator-${seed}`
 * - userId: `user-${seed}`
 * - handle: `creator-${seed}`
 * - displayName: `Creator ${seed}`
 * - avatarUrl: `https://example.com/avatar-${seed}.png`
 * - bio: `Bio for creator ${seed}`
 * - perkSummary: `Perks for creator ${seed}`
 * - perks: []
 * - isVerified: true for even seeds, false for odd seeds
 * - createdAt: 2020-01-01 UTC plus `seed` days
 * - updatedAt: `createdAt` plus 1 second
 *
 * This helper is intentionally stable: the same seed always returns the same object,
 * and different seeds produce distinct creator values.
 */
export function createSeededCreatorFixture(
   seed: number,
   overrides: Partial<CreatorProfile> = {}
): CreatorProfile {
   const normalizedSeed = Math.max(0, Math.floor(seed));
   const createdAt = new Date(CREATOR_FIXTURE_BASE_DATE);
   createdAt.setUTCDate(createdAt.getUTCDate() + normalizedSeed);
   const finalCreatedAt = overrides.createdAt ?? createdAt;

   return {
      id: `creator-${normalizedSeed}`,
      userId: `user-${normalizedSeed}`,
      handle: `creator-${normalizedSeed}`,
      displayName: `Creator ${normalizedSeed}`,
      bio: `Bio for creator ${normalizedSeed}`,
      avatarUrl: `https://example.com/avatar-${normalizedSeed}.png`,
      perkSummary: `Perks for creator ${normalizedSeed}`,
      perks: [],
      isVerified: normalizedSeed % 2 === 0,
      createdAt: finalCreatedAt,
      updatedAt:
         overrides.updatedAt ?? new Date(finalCreatedAt.getTime() + 1000),
      ...overrides,
   };
}
