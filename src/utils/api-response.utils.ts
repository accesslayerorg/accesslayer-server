// src/utils/api-response.utils.ts
// Shared API response formatters for consistent client-facing responses.

import { Response } from 'express';

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

// ── Error codes ──────────────────────────────────────────────

export const ErrorCode = {
   VALIDATION_ERROR: 'VALIDATION_ERROR',
   NOT_FOUND: 'NOT_FOUND',
   UNAUTHORIZED: 'UNAUTHORIZED',
   FORBIDDEN: 'FORBIDDEN',
   CONFLICT: 'CONFLICT',
   BAD_REQUEST: 'BAD_REQUEST',
   INTERNAL_ERROR: 'INTERNAL_ERROR',
   RATE_LIMIT: 'RATE_LIMIT',
} as const;

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

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
