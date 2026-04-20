import { AsyncController } from '../../types/auth.types';
import { CreatorListQuerySchema } from './creators.schemas';
import { fetchCreatorList } from './creators.utils';
import {
   serializeCreatorList,
   CreatorListResponse,
} from './creators.serializers';
import { mapPublicCreatorStats } from './creators.stats';
import {
   sendSuccess,
   sendValidationError,
} from '../../utils/api-response.utils';
import { ZodError } from 'zod';

/**
 * Controller for GET /api/v1/creators
 *
 * Returns paginated list of creator profiles with summary information.
 * Validates query parameters and applies caching via middleware.
 */
export const httpListCreators: AsyncController = async (req, res, next) => {
   try {
      // Validate query parameters
      const validatedQuery = CreatorListQuerySchema.parse(req.query);

      // Fetch creators and total count
      const [creators, total] = await fetchCreatorList(validatedQuery);

      // Serialize response
      const response: CreatorListResponse = {
         creators: serializeCreatorList(creators),
         pagination: {
            limit: validatedQuery.limit,
            offset: validatedQuery.offset,
            total,
            hasMore: validatedQuery.offset + validatedQuery.limit < total,
         },
      };

      sendSuccess(res, response);
   } catch (error) {
      if (error instanceof ZodError) {
         const details = error.errors.map(err => ({
            field: err.path.join('.'),
            message: err.message,
         }));
         return sendValidationError(res, 'Invalid query parameters', details);
      }
      next(error);
   }
};

/**
 * Controller for GET /api/v1/creators/:id/stats
 *
 * Returns public stats for a specific creator.
 * Creator ID validation is handled upstream by validateCreatorIdParam middleware.
 */
export const httpGetCreatorStats: AsyncController = async (req, res, next) => {
   try {
      const { id } = req.params;

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

      sendSuccess(res, stats, 200, `Creator ${id} stats retrieved`);
   } catch (error) {
      next(error);
   }
};
