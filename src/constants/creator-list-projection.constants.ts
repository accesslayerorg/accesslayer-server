// src/constants/creator-list-projection.constants.ts
// Centralized default field projection constants for creator list reads.
// Route and service layers should reference these instead of inlining field lists.

/**
 * Prisma select fields returned for every creator list read.
 * 
 * This projection includes only the minimal fields needed for list responses,
 * reducing payload size and improving query performance.
 * 
 * Keeping this centralized ensures route, service, and test layers
 * stay in sync without duplicating field lists.
 * 
 * Fields included:
 * - id: Unique identifier for the creator
 * - handle: Creator's unique handle/username
 * - displayName: Creator's display name
 * - avatarUrl: URL to creator's avatar image
 * - isVerified: Verification status badge
 */
export const CREATOR_LIST_DEFAULT_SELECT = {
  id: true,
  handle: true,
  displayName: true,
  avatarUrl: true,
  isVerified: true,
} as const;

export type CreatorListSelectKeys = keyof typeof CREATOR_LIST_DEFAULT_SELECT;
