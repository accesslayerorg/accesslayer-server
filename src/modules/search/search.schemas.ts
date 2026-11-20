// src/modules/search/search.schemas.ts
import { z } from 'zod';
import {
   SEARCH_DEFAULT_LIMIT,
   SEARCH_MAX_LIMIT,
   SEARCH_MAX_QUERY_LENGTH,
   SEARCH_MIN_QUERY_LENGTH,
} from './search.constants';

const querySchema = z
   .string({
      required_error: 'q is required',
      invalid_type_error: 'q must be a string',
   })
   .trim()
   .min(
      SEARCH_MIN_QUERY_LENGTH,
      `Query must be at least ${SEARCH_MIN_QUERY_LENGTH} characters`
   )
   .max(
      SEARCH_MAX_QUERY_LENGTH,
      `Query must be at most ${SEARCH_MAX_QUERY_LENGTH} characters`
   );

/**
 * Query validation for GET /search?q=
 */
export const groupedSearchQuerySchema = z.object({
   q: querySchema,
});

/**
 * Query validation for the full results endpoints:
 * GET /search/keys?q=&limit=&cursor= and GET /search/creators.
 */
export const searchPaginationQuerySchema = z.object({
   q: querySchema,
   limit: z.coerce
      .number()
      .int('limit must be an integer')
      .min(1, 'limit must be at least 1')
      .max(SEARCH_MAX_LIMIT, `limit must be at most ${SEARCH_MAX_LIMIT}`)
      .default(SEARCH_DEFAULT_LIMIT),
   cursor: z.string().min(1, 'cursor must not be empty').optional(),
});

export type GroupedSearchQuery = z.infer<typeof groupedSearchQuerySchema>;
export type SearchPaginationQuery = z.infer<typeof searchPaginationQuerySchema>;
