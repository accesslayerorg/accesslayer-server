import { z } from 'zod';
import { safeIntParam } from '../../utils/query.utils';
import { MIN_PAGE_SIZE, MAX_PAGE_SIZE } from '../../constants/pagination.constants';
import { PUBLIC_OFFSET_PAGINATION_DEFAULTS } from '../../utils/public-list-query-defaults';

/**
 * Valid sort fields for the creator holders endpoint.
 * - key_balance: sort by number of keys held (default, largest first)
 * - held_since: sort by when the wallet first bought a key (earliest first)
 */
export const CREATOR_HOLDER_SORT_FIELDS = ['key_balance', 'held_since'] as const;
export type CreatorHolderSortField = (typeof CREATOR_HOLDER_SORT_FIELDS)[number];

/**
 * Validation schema for GET /creators/:id/holders query parameters.
 */
export const CreatorHoldersQuerySchema = z
  .object({
    limit: safeIntParam({
      defaultValue: PUBLIC_OFFSET_PAGINATION_DEFAULTS.limit,
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
    sort: z
      .enum(CREATOR_HOLDER_SORT_FIELDS)
      .optional()
      .default('key_balance'),
  })
  .strict();

export type CreatorHoldersQueryType = z.infer<typeof CreatorHoldersQuerySchema>;
