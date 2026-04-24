// src/utils/api-response.utils.ts
// Shared API response formatters for consistent client-facing responses.

import { Response } from 'express';
import { ErrorCode, ErrorCodeType } from '../constants/error.constants';

/**
 * Standard API error response shape.
 *
 * Every error returned by the API follows this structure so frontend
 * clients can parse errors predictably.
 *
 * @example
 * {
 *   success: false,
 *   error: {
 *     code: "VALIDATION_ERROR",
 *     message: "Email is required",
 *     details: [{ field: "email", message: "Required" }]
 *   }
 * }
 */
interface ApiErrorResponse {
   success: false;
   error: {
      code: string;
      message: string;
      details?: Array<{ field?: string; message: string }>;
   };
}

/**
 * Standard API success response shape.
 */
interface ApiSuccessResponse<T = unknown> {
   success: true;
   data: T;
   message?: string;
}

/**
 * Standard API pagination metadata.
 */
export interface PaginationMetadata {
   page: number;
   limit: number;
   totalCount: number;
   totalPages: number;
   hasNextPage: boolean;
   hasPrevPage: boolean;
}

/**
 * Standard paginated API response shape.
 */
interface PaginatedResponse<T = unknown> {
   success: true;
   data: T[];
   meta: PaginationMetadata;
   message?: string;
}

export { ErrorCode, ErrorCodeType };

// ── Formatters ───────────────────────────────────────────────

/**
 * Send a formatted error response.
 */
export function sendError(
   res: Response,
   statusCode: number,
   code: ErrorCodeType,
   message: string,
   details?: Array<{ field?: string; message: string }>
): void {
   const body: ApiErrorResponse = {
      success: false,
      error: {
         code,
         message,
         ...(details && details.length > 0 ? { details } : {}),
      },
   };
   res.status(statusCode).json(body);
}

/**
 * Send a formatted success response.
 */
export function sendSuccess<T>(
   res: Response,
   data: T,
   statusCode = 200,
   message?: string
): void {
   // Emit Link headers if pagination metadata is detected in the response body
   if (data && typeof data === 'object' && 'meta' in data) {
      const meta = (data as any).meta;
      if (meta && typeof meta === 'object') {
         const linkHeader = getLinkHeader(res.req as Request, meta);
         if (linkHeader) {
            res.setHeader('Link', linkHeader);
         }
      }
   }

   const body: ApiSuccessResponse<T> = {
      success: true,
      data,
      ...(message ? { message } : {}),
   };
   res.status(statusCode).json(body);
}

/**
 * Send a formatted paginated success response.
 */
export function sendPaginatedSuccess<T>(
   res: Response,
   data: T[],
   meta: PaginationMetadata,
   statusCode = 200,
   message?: string
): void {
   const linkHeader = getLinkHeader(res.req as Request, meta);
   if (linkHeader) {
      res.setHeader('Link', linkHeader);
   }

   const body: PaginatedResponse<T> = {
      success: true,
      data,
      meta,
      ...(message ? { message } : {}),
   };
   res.status(statusCode).json(body);
}

// ── Convenience helpers ──────────────────────────────────────

export function sendValidationError(
   res: Response,
   message: string,
   details?: Array<{ field?: string; message: string }>
): void {
   sendError(res, 400, ErrorCode.VALIDATION_ERROR, message, details);
}

export function sendNotFound(res: Response, resource: string): void {
   sendError(res, 404, ErrorCode.NOT_FOUND, `${resource} not found`);
}

export function sendUnauthorized(
   res: Response,
   message = 'Unauthorized access'
): void {
   sendError(res, 401, ErrorCode.UNAUTHORIZED, message);
}

export function sendForbidden(
   res: Response,
   message = 'Access forbidden'
): void {
   sendError(res, 403, ErrorCode.FORBIDDEN, message);
}

export function sendConflict(res: Response, message: string): void {
   sendError(res, 409, ErrorCode.CONFLICT, message);
}

// ── Pagination Link headers ──────────────────────────────────

/**
 * Generates RFC 5988 compatible Link headers for pagination.
 */
function getLinkHeader(
   req: Request,
   meta: PaginationMetadata | OffsetPaginationMeta
): string | null {
   const protocol = req.protocol;
   const host = req.get('host');
   if (!host) return null;

   const fullUrl = `${protocol}://${host}${req.originalUrl}`;
   const url = new URL(fullUrl);
   const links: string[] = [];

   if ('page' in meta) {
      // Page-based pagination
      if (meta.hasNextPage) {
         const nextUrl = new URL(url.toString());
         nextUrl.searchParams.set('page', String(meta.page + 1));
         links.push(`<${nextUrl.toString()}>; rel="next"`);
      }
      if (meta.hasPrevPage) {
         const prevUrl = new URL(url.toString());
         prevUrl.searchParams.set('page', String(meta.page - 1));
         links.push(`<${prevUrl.toString()}>; rel="prev"`);
      }
   } else if ('offset' in meta) {
      // Offset-based pagination
      if (meta.hasMore) {
         const nextUrl = new URL(url.toString());
         nextUrl.searchParams.set('offset', String(meta.offset + meta.limit));
         links.push(`<${nextUrl.toString()}>; rel="next"`);
      }
      if (meta.offset > 0) {
         const prevUrl = new URL(url.toString());
         const prevOffset = Math.max(0, meta.offset - meta.limit);
         prevUrl.searchParams.set('offset', String(prevOffset));
         links.push(`<${prevUrl.toString()}>; rel="prev"`);
      }
   }

   return links.length > 0 ? links.join(', ') : null;
}
