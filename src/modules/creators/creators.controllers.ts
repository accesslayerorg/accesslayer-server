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

      sendSuccess(res, stats);
   } catch (error) {
      next(error);
   }
};
