// src/constants/creator-detail-include.constants.ts
// Centralized default include-fields for creator detail reads.
// Route and service layers should reference these instead of inlining field lists.

/**
 * Prisma select fields returned for every creator detail read.
 * Keeping this centralized ensures route, service, and test layers
 * stay in sync without duplicating field lists.
 */
export const CREATOR_DETAIL_DEFAULT_SELECT = {
  id: true,
  handle: true,
  displayName: true,
  bio: true,
  avatarUrl: true,
  perks: true,
  isVerified: true,
  createdAt: true,
  updatedAt: true,
} as const;

export type CreatorDetailSelectKeys = keyof typeof CREATOR_DETAIL_DEFAULT_SELECT;
