import { prisma } from '../../utils/prisma.utils';
import { CreatorProfile } from '../../types/profile.types';
import { CreatorListQueryType } from './creators.schemas';
import { mapCreatorListSort } from './creators.sort';
import { serializeCreatorListResponse, CreatorListResponse } from './creators.serializers';
import { buildOffsetPaginationMeta } from '../../utils/pagination.utils';
import { logger } from '../../utils/logger.utils';
import { envConfig } from '../../config';
import { buildCreatorFeedWhere } from './creator-feed-filter-combinator.utils';
import { CREATOR_LIST_DEFAULT_SELECT } from '../../constants/creator-list-projection.constants';

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

   const where = buildCreatorFeedWhere({ verified, search });
   const orderBy = mapCreatorListSort(sort, order);

   // Fetch creators and total count in parallel
   const start = Date.now();
   const [creators, total] = await Promise.all([
      prisma.creatorProfile.findMany({
         where,
         orderBy,
         skip: offset,
         take: limit,
         select: CREATOR_LIST_DEFAULT_SELECT,
      }),
      prisma.creatorProfile.count({ where }),
   ]);

   const durationMs = Date.now() - start;
   if (durationMs > envConfig.CREATOR_LIST_SLOW_QUERY_THRESHOLD_MS) {
      logger.warn({
         msg: 'Slow creator list query',
         durationMs,
         thresholdMs: envConfig.CREATOR_LIST_SLOW_QUERY_THRESHOLD_MS,
         sort,
         order,
         hasSearch: !!search,
         hasVerifiedFilter: verified !== undefined,
         limit,
         offset,
      });
   }

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
