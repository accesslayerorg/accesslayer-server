// src/modules/creator/creator.controller.ts
import { Request, Response } from 'express';
import { ZodError } from 'zod';
import { z } from 'zod';
import {
   sendPaginatedSuccess,
   sendSuccess,
   sendError,
   sendValidationError,
   ErrorCode,
} from '../../utils/api-response.utils';
import { getPaginatedCreators } from './creator.service';
import { parseCreatorSortOptions } from './creator.utils';
import { safeIntParam } from '../../utils/query.utils';
import { mapPublicCreatorStats } from '../creators/creators.stats';
import {
   DEFAULT_PAGE,
   DEFAULT_PAGE_SIZE,
   MIN_PAGE_SIZE,
   MAX_PAGE_SIZE,
} from '../../constants/pagination.constants';

const LegacyCreatorQuerySchema = z.object({
   page: safeIntParam({
      defaultValue: DEFAULT_PAGE,
      min: MIN_PAGE_SIZE,
      max: Number.MAX_SAFE_INTEGER,
      label: 'Page',
   }),
   limit: safeIntParam({
      defaultValue: DEFAULT_PAGE_SIZE,
      min: MIN_PAGE_SIZE,
      max: MAX_PAGE_SIZE,
      label: 'Limit',
   }),
   sortBy: z.string().optional(),
   sortOrder: z.string().optional(),
});

export async function listCreators(req: Request, res: Response) {
   try {
      const { page, limit, sortBy, sortOrder } = LegacyCreatorQuerySchema.parse(
         req.query
      );

      const sort = parseCreatorSortOptions(sortBy, sortOrder);

      const { creators, meta } = await getPaginatedCreators({
         page,
         limit,
         sort,
      });

      return sendPaginatedSuccess(
         res,
         creators,
         meta,
         200,
         'Creators retrieved successfully'
      );
   } catch (error) {
      if (error instanceof ZodError) {
         const details = error.errors.map(err => ({
            field: err.path.join('.'),
            message: err.message,
         }));
         return sendValidationError(res, 'Invalid query parameters', details);
      }
      console.error('Error listing creators:', error);
      return sendError(
         res,
         500,
         ErrorCode.INTERNAL_ERROR,
         'Failed to retrieve creators'
      );
   }
}

export async function getCreatorStats(req: Request, res: Response) {
   const { id } = req.params;

   // TODO: Replace with real metrics lookup by creator ID
   const placeholderMetrics = {
      holderCount: 0,
      totalSupply: 0,
      totalVolume: 0,
      lastActivityAt: undefined,
   };

   const stats = mapPublicCreatorStats(placeholderMetrics);

   return sendSuccess(res, stats, 200, `Creator ${id} stats retrieved`);
}
