import { PublicCreatorSummary } from './creators.fields';

/**
 * Creator summary shape for list responses.
 *
 * Keeps full profile fields out of the list serializer to reduce payload size.
 * Only includes essential information needed for creator listings.
 */
export interface CreatorSummary {
   id: string;
   handle: string;
   displayName: string;
   avatarUrl?: string;
   isVerified: boolean;
}

/**
 * Serializes a public creator summary for list responses.
 *
 * This is now mostly a pass-through as the data is already shaped by the database.
 *
 * @param summary - Public creator summary from database
 * @returns Creator summary suitable for list responses
 */
export function serializeCreatorSummary(
   summary: PublicCreatorSummary
): CreatorSummary {
   return {
      id: summary.id,
      handle: summary.handle,
      displayName: summary.displayName,
      avatarUrl: summary.avatarUrl ?? undefined,
      isVerified: summary.isVerified,
   };
}

/**
 * Serializes multiple creator summaries for list responses.
 *
 * @param summaries - Array of public creator summaries
 * @returns Array of creator summaries
 */
export function serializeCreatorList(
   summaries: PublicCreatorSummary[]
): CreatorSummary[] {
   return summaries.map(serializeCreatorSummary);
}

/**
 * Paginated creator list response shape.
 */
export interface CreatorListResponse {
   creators: CreatorSummary[];
   pagination: {
      limit: number;
      offset: number;
      total: number;
      hasMore: boolean;
   };
}
