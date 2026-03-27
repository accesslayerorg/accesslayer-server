/**
 * Prisma select object for shaping public creator profiles in list responses.
 *
 * Centralizes which fields are exposed to reduce payload size and ensure
 * that sensitive or detailed profile fields aren't accidentally leaked.
 */
export const PUBLIC_CREATOR_LIST_SELECT = {
   id: true,
   handle: true,
   displayName: true,
   avatarUrl: true,
   isVerified: true,
} as const;

/**
 * Type derived from the public creator list select object.
 *
 * Represents the shape of each creator record in a public listing response.
 */
export type PublicCreatorSummary = {
   id: string;
   handle: string;
   displayName: string;
   avatarUrl: string | null;
   isVerified: boolean;
};
