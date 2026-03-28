import { z } from 'zod';
import { CREATOR_LIST_SORT_OPTIONS } from './creators.sort';
import { creatorListSortDirectionQueryParam } from './creators.sort-direction.parse';
import { withCreatorListQueryStringNormalization } from './creators.query-string.utils';
import { safeIntParam } from '../../utils/query.utils';
import {
  
import {
  MIN_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from '../../constants/pagination.constants';
  
   MIN_PAGE_SIZE,
   MAX_PAGE_SIZE,
} from '../../constants/pagination.constants';
import { PUBLIC_OFFSET_PAGINATION_DEFAULTS } from '../../utils/public-list-query-defaults';
import { DEFAULT_CREATOR_LIST_SORT } from '../../constants/creator-list-sort.constants';
import { resolveCreatorListLimit } from './creators.limit.utils';
import { normalizeCreatorListSearchTerm } from './creators.search-term.utils';

/**
 * Validation schema for creator list query parameters.
 *
 * Validates pagination and filter params for GET /api/v1/creators endpoint.
 * Keeps query validation centralized and reusable across creator list handlers.
 *
 * @example
 * GET /api/v1/creators?limit=20&offset=0&sort=createdAt&order=desc&verified=true
 */
export const CreatorListQuerySchema = z.object({
   // Pagination
   limit: safeIntParam({
defaultValue: resolveCreatorListLimit() ?? PUBLIC_OFFSET_PAGINATION_DEFAULTS.limit,
      min: MIN_PAGE_SIZE,
      max: MAX_PAGE_SIZE,
      label: 'Limit',
   }),
   offset: safeIntParam({
      defaultValue: PUBLIC_OFFSET_PAGINATION_DEFAULTS.offset,
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
      label: 'Offset',
   }),

   // Sorting
   sort: withCreatorListQueryStringNormalization(
      z.enum(CREATOR_LIST_SORT_OPTIONS).optional().default(DEFAULT_CREATOR_LIST_SORT)
   ),
   order: creatorListSortDirectionQueryParam(),

   // Filters
   verified: withCreatorListQueryStringNormalization(
      z
         .string()
         .optional()
         .transform(val => {
            if (val === undefined) return undefined;
            return val === 'true';
         })
   ),
   search: withCreatorListQueryStringNormalization(
      z
         .string()
         .optional()
         .transform(val => normalizeCreatorListSearchTerm(val))
   ),
});

export type CreatorListQueryType = z.infer<typeof CreatorListQuerySchema>;
