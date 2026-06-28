import { Response } from 'express';

export const PAGINATION_LINK_HEADER = 'Link';

export type PaginationLinkParams = {
   baseUrl: string;
   query: Record<string, string | number | boolean | undefined>;
   offset: number;
   limit: number;
   total: number;
};

function buildOffsetUrl(
   baseUrl: string,
   query: Record<string, string | number | boolean | undefined>,
   offset: number,
   limit: number,
): string {
   const params = new URLSearchParams();
   for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && key !== 'offset' && key !== 'limit') {
         params.set(key, String(value));
      }
   }
   params.set('offset', String(offset));
   params.set('limit', String(limit));
   return `${baseUrl}?${params.toString()}`;
}

/**
 * Builds an RFC 8288-compliant `Link` header value for offset-paginated list endpoints.
 *
 * Emits `next` and/or `prev` relations depending on position within the result set.
 * Existing query parameters are preserved in the generated URLs; `offset` and `limit`
 * are always overwritten with the computed adjacent-page values.
 *
 * Returns `null` when the entire result set fits on a single page (no links to emit).
 *
 * @param params - Pagination context including base URL, current query, and counts
 * @returns Formatted Link header string, or null when there are no adjacent pages
 *
 * @example
 * buildPaginationLinkHeader({ baseUrl: 'https://api.example.com/creators', query: {}, offset: 10, limit: 10, total: 25 })
 * // => '<https://...?offset=20&limit=10>; rel="next", <https://...?offset=0&limit=10>; rel="prev"'
 */
export function buildPaginationLinkHeader(params: PaginationLinkParams): string | null {
   const { baseUrl, query, offset, limit, total } = params;
   const safeOffset = Math.max(0, offset);
   const safeLimit = Math.max(1, limit);
   const links: string[] = [];

   if (safeOffset + safeLimit < total) {
      const nextUrl = buildOffsetUrl(baseUrl, query, safeOffset + safeLimit, safeLimit);
      links.push(`<${nextUrl}>; rel="next"`);
   }

   if (safeOffset > 0) {
      const prevOffset = Math.max(0, safeOffset - safeLimit);
      const prevUrl = buildOffsetUrl(baseUrl, query, prevOffset, safeLimit);
      links.push(`<${prevUrl}>; rel="prev"`);
   }

   return links.length > 0 ? links.join(', ') : null;
}

/**
 * Attaches pagination Link headers to the response when adjacent pages exist.
 *
 * Keeps existing response body pagination metadata untouched — the `Link`
 * header is an additive navigation hint for API clients that prefer header-driven
 * pagination (e.g. GitHub-style).
 *
 * @param res - Express response object
 * @param params - Pagination context
 */
export function attachPaginationLinkHeaders(res: Response, params: PaginationLinkParams): void {
   const header = buildPaginationLinkHeader(params);
   if (header !== null) {
      res.set(PAGINATION_LINK_HEADER, header);
   }
}
