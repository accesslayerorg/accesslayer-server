// src/modules/creator/creator.controller.ts
import { Request, Response } from 'express';
import { z } from 'zod';
import {
   sendSuccess,
   sendError,
   sendValidationError,
   ErrorCode,
} from '../../utils/api-response.utils';
import { getPaginatedCreators } from './creator.service';
import { parseCreatorSortOptions } from './creator.utils';
import { safeIntParam } from '../../utils/query.utils';
import { parsePublicQuery } from '../../utils/public-query-parse.utils';
import { wrapPublicCreatorListResponse } from '../creators/public-creator-list-envelope.utils';
import { buildCreatorListRequestContext } from '../creators/creator-list-context.utils';
import {
   MIN_PAGE_SIZE,
   MAX_PAGE_SIZE,
} from '../../constants/pagination.constants';
import { PUBLIC_PAGE_PAGINATION_DEFAULTS } from '../../utils/public-list-query-defaults';

const LegacyCreatorQuerySchema = z.object({
   page: safeIntParam({
      defaultValue: PUBLIC_PAGE_PAGINATION_DEFAULTS.page,
      min: MIN_PAGE_SIZE,
      max: Number.MAX_SAFE_INTEGER,
      label: 'Page',
   }),
   limit: safeIntParam({
      defaultValue: PUBLIC_PAGE_PAGINATION_DEFAULTS.limit,
      min: MIN_PAGE_SIZE,
      max: MAX_PAGE_SIZE,
      label: 'Limit',
   }),
   sortBy: z.string().optional(),
   sortOrder: z.string().optional(),
});

export async function listCreators(req: Request, res: Response) {
   try {
      const ctx = buildCreatorListRequestContext(req);
      const parsed = parsePublicQuery(LegacyCreatorQuerySchema, ctx.query);
      if (!parsed.ok) {
         return sendValidationError(res, 'Invalid query parameters', parsed.details);
      }
      const { page, limit, sortBy, sortOrder } = parsed.data;

      const sort = parseCreatorSortOptions(sortBy, sortOrder);

      const { creators, meta } = await getPaginatedCreators({
         page,
         limit,
         sort,
      });

      return sendSuccess(
         res,
         wrapPublicCreatorListResponse(creators, meta),
         200,
         'Creators retrieved successfully'
      );
   } catch (error) {
      console.error('Error listing creators:', error);
      return sendError(
         res,
         500,
         ErrorCode.INTERNAL_ERROR,
         'Failed to retrieve creators'
      );
   }
}
