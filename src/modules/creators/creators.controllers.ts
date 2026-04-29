import { AsyncController } from '../../types/auth.types';
import { CreatorListQuerySchema } from './creators.schemas';
import { fetchCreatorList } from './creators.utils';
import {
   serializeCreatorListResponse,
   CreatorListResponse,
} from './creators.serializers';
import { mapPublicCreatorStats } from './creators.stats';
import {
   sendSuccess,
   sendValidationError,
} from '../../utils/api-response.utils';
import { attachTimestampHeader } from '../../utils/timestamp-headers.utils';
import { parsePublicQuery } from '../../utils/public-query-parse.utils';
import { buildOffsetPaginationMeta } from '../../utils/pagination.utils';
import { buildCreatorListRequestContext } from './creator-list-context.utils';

/**
 * Controller for GET /api/v1/creators
 *
 * Returns paginated list of creator profiles with summary information.
 * Validates query parameters and applies caching via middleware.
 */
export const httpListCreators: AsyncController = async (req, res, next) => {
   try {
      const ctx = buildCreatorListRequestContext(req);

      // Validate query parameters
      const parsed = parsePublicQuery(
         CreatorListQuerySchema, 
         ctx.query,
         { debugContext: 'creator-list-query' }
      );
      if (!parsed.ok) {
         return sendValidationError(res, 'Invalid query parameters', parsed.details);
      }
      const validatedQuery = parsed.data;

      // Fetch creators and total count
      const [creators, total] = await fetchCreatorList(validatedQuery);

      const response: CreatorListResponse = serializeCreatorListResponse(
         creators,
         buildOffsetPaginationMeta({
            limit: validatedQuery.limit,
            offset: validatedQuery.offset,
            total,
         })
      );

      attachTimestampHeader(res);
      sendSuccess(res, response);
   } catch (error) {
      next(error);
   }
};

/**
 * Controller for GET /api/v1/creators/:id/stats
 *
 * Returns public stats for a specific creator.
 * Validates creator ID and applies caching via middleware.
 */
export const httpGetCreatorStats: AsyncController = async (req, res, next) => {
   try {
      const { id } = req.params;

      // Validate creator ID format (basic validation)
      if (!id || typeof id !== 'string') {
         return sendValidationError(res, 'Invalid creator ID', [
            { field: 'id', message: 'Creator ID must be a valid string' },
         ]);
      }

      // TODO: Fetch actual creator metrics from database/service
      // For now, return placeholder data
      const placeholderMetrics = {
         holderCount: 0,
         totalSupply: 0,
         totalVolume: 0,
         lastActivityAt: undefined,
      };

      // Serialize using the public stats mapper
      const stats = mapPublicCreatorStats(placeholderMetrics);

      attachTimestampHeader(res);
      sendSuccess(res, stats);
   } catch (error) {
      next(error);
   }
};
