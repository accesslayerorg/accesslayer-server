// src/utils/api-response.utils.ts
// Shared API response formatters for consistent client-facing responses.

import { Response } from 'express';
import { ZodIssue } from 'zod';
import { ErrorCode, ErrorCodeType } from '../constants/error.constants';
import { requestContextStorage } from './als.utils';

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
   requestId?: string;
   error: {
      code: string;
      message: string;
      details?: Array<{ field?: string; message: string }>;
   };
}

/**
 * Builds a structured error response body, embedding the request ID from the
 * current async-local-storage context when available. The `requestId` field is
 * omitted entirely when no context is active, keeping the shape clean for
 * callers that run outside a request lifecycle (e.g. tests, scripts).
 *
 * Use this instead of constructing `ApiErrorResponse` literals directly so
 * that request IDs are consistently included and can be correlated with server
 * log entries.
 *
 * @param code    - Machine-readable error code
 * @param message - Human-readable error message
 * @param details - Optional per-field validation details
 * @returns       Structured error response body ready to pass to `res.json()`
 *
 * @example
 * res.status(400).json(buildErrorResponse(ErrorCode.VALIDATION_ERROR, 'Bad input'));
 */
export function buildErrorResponse(
   code: ErrorCodeType,
   message: string,
   details?: Array<{ field?: string; message: string }>
): ApiErrorResponse {
   const requestId = requestContextStorage.getStore()?.requestId;
   const body: ApiErrorResponse = {
      success: false,
      ...(requestId ? { requestId } : {}),
      error: {
         code,
         message,
         ...(details && details.length > 0 ? { details } : {}),
      },
   };
   return body;
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
   res.setHeader('Content-Type', 'application/json');
   res.status(statusCode).json(buildErrorResponse(code, message, details));
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
   res.setHeader('Content-Type', 'application/json');
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
   res.setHeader('Content-Type', 'application/json');
   res.status(statusCode).json(body);
}

// ── Convenience helpers ──────────────────────────────────────

/**
 * Maps Zod issues to the standard `details` array used in error responses.
 *
 * @example
 * const result = schema.safeParse(input);
 * if (!result.success) {
 *   return sendValidationError(res, 'Invalid input', zodIssuesToDetails(result.error.issues));
 * }
 */
export function zodIssuesToDetails(
   issues: ZodIssue[]
): Array<{ field: string; message: string }> {
   return issues.map(issue => ({
      field: issue.path.join('.'),
      message: issue.message,
   }));
}

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
   message = 'Unauthorized access',
   details?: Array<{ field?: string; message: string }>
): void {
   sendError(res, 401, ErrorCode.UNAUTHORIZED, message, details);
}

export function sendForbidden(
   res: Response,
   message = 'Access forbidden',
   details?: Array<{ field?: string; message: string }>
): void {
   sendError(res, 403, ErrorCode.FORBIDDEN, message, details);
}

export function sendConflict(res: Response, message: string): void {
   sendError(res, 409, ErrorCode.CONFLICT, message);
}
