/**
 * Cursor-based pagination types.
 *
 * Stub types for future cursor-based creator list pagination.
 * These are intentionally unused — they establish the contract
 * for cursor pagination before any endpoint adopts it.
 *
 * @see https://github.com/accesslayerorg/accesslayer-server/issues/42
 */

/** Input parameters for a cursor-paginated query. */
export interface CursorPaginationParams {
   /** Opaque cursor string; omit for the first page. */
   cursor?: string;
   /** Maximum items to return (default comes from pagination constants). */
   limit?: number;
}

/** Response metadata for cursor-paginated results. */
export interface CursorPaginationMeta {
   /** Cursor pointing to the next page, or null when no more results. */
   nextCursor: string | null;
   /** Whether more results exist beyond the current page. */
   hasMore: boolean;
}

/** Generic wrapper for a cursor-paginated response. */
export interface CursorPaginatedResult<T> {
   data: T[];
   pagination: CursorPaginationMeta;
}
