// src/modules/creator/creator.controller.ts
import { RequestHandler } from 'express';

// API response helpers
import {
  sendSuccess,
  sendError,
  sendValidationError,
  ErrorCode,
} from '../../utils/api-response.utils';
import { attachTimestampHeader } from '../../utils/timestamp-headers.utils';
import { getPaginatedCreators } from './creator.service';
import { parseCreatorSortOptions } from './creator.utils';
import { parsePublicQuery } from '../../utils/public-query-parse.utils';
import { wrapPublicCreatorListResponse } from '../creators/public-creator-list-envelope.utils';
import { buildCreatorListRequestContext } from '../creators/creator-list-context.utils';
import { normalizeCreatorListPage } from './creator-list-page.guard';

// Legacy query schema
import { LegacyCreatorQuerySchema } from '../creators/creators.schemas';

// Typed Express handler
export const listCreators: RequestHandler = async (req, res) => {
  try {
    // Build request context
    const ctx = buildCreatorListRequestContext(req);

    // Parse query using legacy schema
    const parsed = parsePublicQuery(LegacyCreatorQuerySchema, ctx.query);

    if (!parsed.ok) {
      return sendValidationError(res, 'Invalid query parameters', parsed.details);
    }

    // Destructure using schema fields
    const { offset, limit, sort, order: sortOrder } = parsed.data;

    // Convert offset to page number
    const page = normalizeCreatorListPage(offset);

    // Build sort options
    const sortOptions = parseCreatorSortOptions(sort, sortOrder);

    // Fetch paginated creators
    const { creators, meta } = await getPaginatedCreators({
      page,
      limit,
      sort: sortOptions,
    });

      attachTimestampHeader(res);
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
