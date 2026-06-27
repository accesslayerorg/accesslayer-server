/**
 * Shared builder for paginated list response envelopes.
 *
 * All paginated list endpoints return a consistent envelope shape:
 * `{ data: T[], meta: { total, hasMore, nextCursor? } }`.
 *
 * This helper centralizes the envelope construction to ensure the shape
 * stays consistent across all list endpoints.
 */

/**
 * Metadata for list responses.
 *
 * - `total`: Total number of items available across all pages
 * - `hasMore`: Whether more results exist beyond the current page
 * - `nextCursor`: Optional cursor for the next page (omitted when undefined)
 */
export interface ListResponseMeta {
   total: number;
   hasMore: boolean;
   nextCursor?: string;
}

/**
 * Standard list response envelope.
 *
 * @template T - Type of items in the data array
 */
export interface ListResponse<T> {
   data: T[];
   meta: {
      total: number;
      hasMore: boolean;
      nextCursor?: string;
   };
}

/**
 * Builds a consistent list response envelope.
 *
 * Returns `{ data, meta }` where meta contains `total`, `hasMore`, and
 * optionally `nextCursor`. When `nextCursor` is undefined, it is omitted
 * from the output (not serialized as `null`).
 *
 * @template T - Type of items in the data array
 * @param data - Array of items for the current page
 * @param meta - Pagination metadata
 * @returns Structured list response envelope
 *
 * @example
 * // Offset pagination (no cursor)
 * const response = buildListResponse(items, {
 *   total: 100,
 *   hasMore: true
 * });
 * // Returns: { data: [...], meta: { total: 100, hasMore: true } }
 *
 * @example
 * // Cursor pagination (with cursor)
 * const response = buildListResponse(items, {
 *   total: 100,
 *   hasMore: true,
 *   nextCursor: 'eyJpZCI6MTIzfQ=='
 * });
 * // Returns: { data: [...], meta: { total: 100, hasMore: true, nextCursor: '...' } }
 *
 * @example
 * // Empty result
 * const response = buildListResponse([], {
 *   total: 0,
 *   hasMore: false
 * });
 * // Returns: { data: [], meta: { total: 0, hasMore: false } }
 */
export function buildListResponse<T>(
   data: T[],
   meta: ListResponseMeta
): ListResponse<T> {
   const response: ListResponse<T> = {
      data,
      meta: {
         total: meta.total,
         hasMore: meta.hasMore,
      },
   };

   // Only include nextCursor when it's defined
   if (meta.nextCursor !== undefined) {
      response.meta.nextCursor = meta.nextCursor;
   }

   return response;
}
