import { prisma } from '../../utils/prisma.utils';
import { CreatorProfile } from '../../types/profile.types';
import { CreatorListQueryType } from './creators.schemas';
import { mapCreatorListSort } from './creators.sort';
import { serializeCreatorListResponse, CreatorListResponse } from './creators.serializers';
import { buildOffsetPaginationMeta } from '../../utils/pagination.utils';
import { normalizeCreatorListSearchTerm } from './creators.search-term.utils';

type CreatorListWhere = {
   isVerified?: boolean;
   OR?: Array<{
      handle?: { contains: string; mode: 'insensitive' };
      displayName?: { contains: string; mode: 'insensitive' };
   }>;
};

/**
 * Fetch paginated list of creators from the database.
 *
 * @param query - Validated query parameters for pagination and filtering
 * @returns Tuple of [creators, total count]
 */
export async function fetchCreatorList(
   query: CreatorListQueryType
): Promise<[CreatorProfile[], number]> {
   const { limit, offset, sort, order, verified, search } = query;

   // Build where clause for filters
   const where: CreatorListWhere = {};

   if (verified !== undefined) {
      where.isVerified = verified;
   }

   const normalizedSearch = normalizeCreatorListSearchTerm(search);

   if (normalizedSearch) {
      where.OR = [
         { handle: { contains: normalizedSearch, mode: 'insensitive' } },
         { displayName: { contains: normalizedSearch, mode: 'insensitive' } },
      ];
   }

   const orderBy = mapCreatorListSort(sort, order);

   // Fetch creators and total count in parallel
   const [creators, total] = await Promise.all([
      prisma.creatorProfile.findMany({
         where,
         orderBy,
         skip: offset,
         take: limit,
      }),
      prisma.creatorProfile.count({ where }),
   ]);

   return [creators as unknown as CreatorProfile[], total];
}

/**
 * Creates a consistent empty response for creator list endpoints.
 *
 * Ensures empty list responses maintain the same shape as paginated responses,
 * allowing clients to rely on consistent structure even when no data exists.
 *
 * @param query - Validated query parameters used for the request
 * @returns Empty creator list response with proper pagination metadata
 *
 * @example
 * const emptyResponse = createEmptyCreatorListResponse(validatedQuery);
 * // Returns: { items: [], meta: { limit, offset, total: 0, hasMore: false } }
 */
export function createEmptyCreatorListResponse(
   query: CreatorListQueryType
): CreatorListResponse {
   return serializeCreatorListResponse(
      [],
      buildOffsetPaginationMeta({
         limit: query.limit,
         offset: query.offset,
         total: 0,
      })
   );
}
