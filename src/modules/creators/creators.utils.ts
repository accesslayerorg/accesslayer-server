import { prisma } from '../../utils/prisma.utils';
import { CreatorProfile } from '../../types/profile.types';
import { CreatorListQueryType } from './creators.schemas';
import { mapCreatorListSort } from './creators.sort';
import {
   serializeCreatorListResponse,
   CreatorListResponse,
} from './creators.serializers';
import { buildOffsetPaginationMeta } from '../../utils/pagination.utils';
import { logger } from '../../utils/logger.utils';
import { envConfig } from '../../config';
import { buildCreatorFeedWhere, CreatorFeedWhere } from './creator-feed-filter-combinator.utils';
import { CREATOR_LIST_DEFAULT_SELECT } from '../../constants/creator-list-projection.constants';
import { getCachedCreatorList, setCachedCreatorList } from './creators.cache';
import { captureQueryPlan } from '../../utils/query-plan.utils';

/**
 * Fetch paginated list of creators from the database.
 *
 * @param query - Validated query parameters for pagination and filtering
 * @returns Tuple of [creators, total count]
 */
export async function fetchCreatorList(
   query: CreatorListQueryType
): Promise<[CreatorProfile[], number]> {
   const cached = getCachedCreatorList(query);
   if (cached) {
      return [cached.creators, cached.total];
   }

   const { limit, offset, sort, order, verified, search, minPrice, maxPrice } = query;

   const where = buildCreatorFeedWhere({ verified, search, minPrice, maxPrice });
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

   // Emit a structured debug log after every creator list query (#550).
   // Only include filter keys that were actually provided in the request;
   // cursor is intentionally excluded from the log output.
   const activeFilters: Record<string, unknown> = {};
   if (verified !== undefined) activeFilters.verified = verified;
   if (search !== undefined && search !== '') activeFilters.search = search;
   if (minPrice !== undefined) activeFilters.minPrice = minPrice.toString();
   if (maxPrice !== undefined) activeFilters.maxPrice = maxPrice.toString();

   logger.debug(
      {
         result_count: creators.length,
         filters: activeFilters,
         sort,
         query_duration_ms: durationMs,
      },
      'Creator list query resolved'
   );

   if (durationMs > envConfig.CREATOR_LIST_SLOW_QUERY_THRESHOLD_MS) {
      // In debug (development) mode, capture the query execution plan so
      // missing indexes and inefficient joins are immediately visible in logs.
      // The plan is never collected in production to avoid extra round-trips
      // and log bloat.
      const queryPlan =
         envConfig.MODE === 'development'
            ? await captureQueryPlan(
                 buildCreatorFeedExplainSql(where),
                 buildCreatorFeedExplainParams(where)
              )
            : null;

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
         ...(queryPlan !== null && { queryPlan }),
      });
   }

   setCachedCreatorList(query, creators as unknown as CreatorProfile[], total);

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

// ── Query-plan helpers ────────────────────────────────────────────────────────

/**
 * Builds the raw SQL SELECT that mirrors the Prisma `findMany` for the creator
 * feed.  The statement is used exclusively as the argument to EXPLAIN and is
 * never executed directly.
 *
 * @param where - The Prisma where clause produced by `buildCreatorFeedWhere`.
 * @returns A parameterised SQL string (positional `$N` placeholders).
 */
export function buildCreatorFeedExplainSql(where: CreatorFeedWhere): string {
   const conditions: string[] = [];
   let paramIndex = 1;

   if (where.isVerified !== undefined) {
      conditions.push(`"isVerified" = $${paramIndex++}`);
   }

   if (where.OR && where.OR.length > 0) {
      conditions.push(
         `("handle" ILIKE $${paramIndex++} OR "displayName" ILIKE $${paramIndex++})`
      );
   }

   const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

   return `SELECT * FROM "CreatorProfile" ${whereClause}`;
}

/**
 * Builds the ordered list of parameter values that correspond to the
 * positional placeholders produced by `buildCreatorFeedExplainSql`.
 *
 * @param where - The Prisma where clause produced by `buildCreatorFeedWhere`.
 * @returns An array of values in the same order as the SQL placeholders.
 */
export function buildCreatorFeedExplainParams(where: CreatorFeedWhere): unknown[] {
   const params: unknown[] = [];

   if (where.isVerified !== undefined) {
      params.push(where.isVerified);
   }

   if (where.OR && where.OR.length > 0) {
      // Both handle and displayName use the same search term.
      const searchTerm = where.OR[0]?.handle?.contains ?? '';
      params.push(`%${searchTerm}%`);
      params.push(`%${searchTerm}%`);
   }

   return params;
}
