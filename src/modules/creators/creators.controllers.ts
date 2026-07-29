import { AsyncController } from '../../types/auth.types';
import { CreatorListQuerySchema } from './creators.schemas';
import { fetchCreatorList } from './creators.utils';
import { prisma } from '../../utils/prisma.utils';
import { compute24hVolume } from '../../utils/trading-volume.utils';
import {
   serializeCreatorListResponse,
   CreatorListResponse,
} from './creators.serializers';
import { mapPublicCreatorStats } from './creators.stats';
import {
   sendSuccess,
   sendValidationError,
   sendNotFound,
} from '../../utils/api-response.utils';
import { attachTimestampHeader } from '../../utils/timestamp-headers.utils';
import { parsePublicQuery } from '../../utils/public-query-parse.utils';
import { buildOffsetPaginationMeta } from '../../utils/pagination.utils';
import { buildCreatorListRequestContext } from './creator-list-context.utils';
import { warnIfUnrecognizedCreatorListSort } from './creators.sort-field.utils';
import { warnIfOutOfRangeCursor } from './creators.cursor-warning.utils';
import {
   incrementFilterParseError,
   type FilterParseErrorCategory,
} from '../../utils/filter-parse-metrics.utils';
import { parseCreatorId } from '../../utils/creator-id.utils';
import {
   creatorProfileExists,
   getCreatorProfile,
} from '../creator/creator-profile.service';

/**
 * Controller for GET /api/v1/creators
 *
 * Returns paginated list of creator profiles with summary information.
 * Validates query parameters and applies caching via middleware.
 */
export const httpListCreators: AsyncController = async (req, res, next) => {
   try {
      const ctx = buildCreatorListRequestContext(req);

      warnIfUnrecognizedCreatorListSort(ctx.query, req.requestId);

      // Validate query parameters
      const parsed = parsePublicQuery(CreatorListQuerySchema, ctx.query, {
         debugContext: 'creator-list-query',
      });
      if (!parsed.ok) {
         // Increment filter parse error counter
         const category = categorizeParseError(parsed.details);
         incrementFilterParseError('/api/v1/creators', category);
         return sendValidationError(
            res,
            'Invalid query parameters',
            parsed.details
         );
      }
      const validatedQuery = parsed.data;

      // Check for out-of-range pagination cursor
      if (validatedQuery.cursor) {
         await warnIfOutOfRangeCursor({
            cursor: validatedQuery.cursor,
            route: req.path,
            requestId: req.requestId,
            query: validatedQuery,
         });
      }

      // Fetch creators and total count
      const [creators, total] = await fetchCreatorList(validatedQuery);

      const response: CreatorListResponse = serializeCreatorListResponse(
         creators,
         buildOffsetPaginationMeta({
            limit: validatedQuery.limit,
            offset: validatedQuery.offset,
            total,
         }),
         validatedQuery.search
      );

      attachTimestampHeader(res);
      sendSuccess(res, response);
   } catch (error) {
      next(error);
   }
};

/**
 * Categorize a parse error based on the validation details.
 *
 * @param details - Validation error details from parsePublicQuery
 * @returns The error category for metrics labeling
 */
function categorizeParseError(
   details: Array<{ field: string; message: string }>
): FilterParseErrorCategory {
   // Check for unknown key errors (strict mode violations)
   if (
      details.some(
         d =>
            d.message.includes('unrecognized') || d.message.includes('unknown')
      )
   ) {
      return 'unknown_key';
   }
   // Default to invalid_value for type/range errors
   return 'invalid_value';
}

/**
 * Controller for GET /api/v1/creators/:id/stats
 *
 * Returns public stats for a specific creator.
 * Validates creator ID and applies caching via middleware.
 */
export const httpGetCreatorStats: AsyncController = async (req, res, next) => {
   try {
      const rawId = req.params.id;
      const parsedId = parseCreatorId(Array.isArray(rawId) ? rawId[0] : rawId);
      const creatorIdStr = String(parsedId);

      const creator = await prisma.creatorProfile.findFirst({
         where: { OR: [{ id: creatorIdStr }, { handle: creatorIdStr }] },
         select: { id: true },
      });
      const resolvedId = creator ? creator.id : creatorIdStr;

      const [holderCount, supplyAggregate, priceSnapshot] = await Promise.all([
         prisma.keyOwnership.count({
            where: {
               creatorId: resolvedId,
               balance: { gt: 0 },
            },
         }),
         // Bug fix (#678): totalSupply was previously hardcoded to 0 instead
         // of being derived from the ownership read model, so it never
         // reflected keys minted by buy transactions.
         prisma.keyOwnership.aggregate({
            where: { creatorId: resolvedId },
            _sum: { balance: true },
         }),
         prisma.creatorPriceSnapshot.findUnique({
            where: { creatorId: resolvedId },
            select: { currentPrice: true },
         }),
      ]);

      const totalSupply = Number(supplyAggregate._sum.balance ?? 0);
      const currentPrice = priceSnapshot
         ? priceSnapshot.currentPrice.toString()
         : null;

      const metrics = {
         holderCount,
         totalSupply,
         totalVolume: 0,
         currentPrice,
         lastActivityAt: undefined,
      };

      // Serialize using the public stats mapper
      const stats = mapPublicCreatorStats(metrics);

      attachTimestampHeader(res);
      sendSuccess(res, stats);
   } catch (error) {
      next(error);
   }
};

/**
 * Controller for GET /api/v1/creators/:id
 *
 * Returns public profile details for a specific creator.
 */
export const httpGetCreator: AsyncController = async (req, res, next) => {
   try {
      const rawId = req.params.id;
      const creatorId = Array.isArray(rawId) ? rawId[0] : rawId;

      if (!(await creatorProfileExists(creatorId))) {
         return sendNotFound(res, 'Creator');
      }

      const profile = await getCreatorProfile(creatorId);
      attachTimestampHeader(res);
      sendSuccess(res, profile, 200, 'Creator retrieved successfully');
   } catch (error) {
      next(error);
   }
};

/**
 * Controller for GET /api/v1/creators/leaderboard
 *
 * Returns creators ranked by holder count descending. Ties are broken
 * alphabetically by creator (Stellar wallet) address so the ordering is
 * stable across requests regardless of database iteration order.
 */
export const httpGetCreatorLeaderboard: AsyncController = async (
   _req,
   res,
   next
) => {
   try {
      const creators = await prisma.creatorProfile.findMany({
         select: {
            id: true,
            handle: true,
            priceSnapshot: {
               select: { currentPrice: true },
            },
            user: {
               select: {
                  stellarWallet: {
                     select: { address: true },
                  },
               },
            },
         },
      });

      const entries = await Promise.all(
         creators.map(async creator => {
            const holderCount = await prisma.keyOwnership.count({
               where: {
                  creatorId: creator.id,
                  balance: { gt: 0 },
               },
            });

            const address =
               (creator as any).user?.stellarWallet?.address ?? creator.handle;
            const currentPrice = (creator as any).priceSnapshot
               ? (creator as any).priceSnapshot.currentPrice.toString()
               : '0';

            return {
               creator: address as string,
               holder_count: holderCount,
               current_price: currentPrice,
            };
         })
      );

      entries.sort((a, b) => {
         if (b.holder_count !== a.holder_count) {
            return b.holder_count - a.holder_count;
         }
         // Stable, deterministic tie-break: ascending alphabetical order
         // by creator address.
         if (a.creator < b.creator) return -1;
         if (a.creator > b.creator) return 1;
         return 0;
      });

      const items = entries.map((entry, index) => ({
         rank: index + 1,
         ...entry,
      }));

      attachTimestampHeader(res);
      sendSuccess(res, { items });
   } catch (error) {
      next(error);
   }
};

/**
 * Controller for GET /api/v1/creators/trending
 *
 * Returns creators ordered by 24h trading volume descending.
 * Respects pagination limit parameters.
 */
export const httpGetTrendingCreators: AsyncController = async (
   req,
   res,
   next
) => {
   try {
      const ctx = buildCreatorListRequestContext(req);

      const parsed = parsePublicQuery(CreatorListQuerySchema, ctx.query, {
         debugContext: 'creator-trending-query',
      });
      if (!parsed.ok) {
         return sendValidationError(
            res,
            'Invalid query parameters',
            parsed.details
         );
      }
      const validatedQuery = parsed.data;
      const limit = validatedQuery.limit;

      // Fetch all creators
      const creators = await prisma.creatorProfile.findMany({
         select: {
            id: true,
            handle: true,
            displayName: true,
            avatarUrl: true,
            isVerified: true,
            createdAt: true,
            updatedAt: true,
         },
      });

      // Compute volume for each creator
      const creatorsWithVolume = await Promise.all(
 feature/creator-search-no-results-state
         creators.map(async (creator: { id: string; handle: string; displayName: string | null; avatarUrl: string | null; isVerified: boolean; createdAt: Date; updatedAt: Date }) => {

         creators.map(async creator => {
 main
            const volume = await compute24hVolume(creator.id);
            return {
               id: creator.id,
               handle: creator.handle,
               displayName: creator.displayName,
               avatarUrl: creator.avatarUrl,
               isVerified: creator.isVerified,
               createdAt: creator.createdAt.toISOString(),
               updatedAt: creator.updatedAt.toISOString(),
               volume_24h: volume.toString(),
            };
         })
      );

      // Sort by volume descending
      creatorsWithVolume.sort((a: { volume_24h: string }, b: { volume_24h: string }) => {
         const volA = BigInt(a.volume_24h);
         const volB = BigInt(b.volume_24h);
         if (volB > volA) return 1;
         if (volB < volA) return -1;
         return 0;
      });

      // Slice list based on limit
      const items = creatorsWithVolume.slice(0, limit);

      attachTimestampHeader(res);
      sendSuccess(res, { items });
   } catch (error) {
      next(error);
   }
};
