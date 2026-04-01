import { z } from 'zod';
import { creatorListSortDirectionQueryParam } from './creators.sort-direction.parse';
import { creatorListIncludeQueryParam } from './creators.include.parse';
import { withCreatorListQueryStringNormalization } from './creators.query-string.utils';
import { safeIntParam } from '../../utils/query.utils';
import {
  MIN_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from '../../constants/pagination.constants';
import { PUBLIC_OFFSET_PAGINATION_DEFAULTS } from '../../utils/public-list-query-defaults';

import {
  CREATOR_LIST_SORT_FIELDS,
  DEFAULT_CREATOR_LIST_SORT,
} from '../../constants/creator-list-sort.constants';
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
export const CreatorListQuerySchema = z
  .object({
    // Pagination
    limit: safeIntParam({
      defaultValue:
        resolveCreatorListLimit() ??
        PUBLIC_OFFSET_PAGINATION_DEFAULTS.limit,
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
      z
        .enum(CREATOR_LIST_SORT_FIELDS)
        .optional()
        .default(DEFAULT_CREATOR_LIST_SORT)
    ),

    order: creatorListSortDirectionQueryParam(),

    include: creatorListIncludeQueryParam(),

    // Filters
    verified: withCreatorListQueryStringNormalization(
      z
        .string()
        .optional()
        .transform(val =>
          val === undefined ? undefined : val === 'true'
        )
    ),

    search: withCreatorListQueryStringNormalization(
      z
        .string()
        .optional()
        .transform(val => normalizeCreatorListSearchTerm(val))
    ),
  })
  .strict();

// Export as LegacyCreatorQuerySchema for backward compatibility
export const LegacyCreatorQuerySchema = CreatorListQuerySchema;

export type CreatorListQueryType = z.infer<typeof CreatorListQuerySchema>;