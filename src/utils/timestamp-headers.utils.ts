// src/utils/timestamp-headers.utils.ts
// Centralizes timestamp header formatting for public creator-facing responses.

import { Response } from 'express';

/**
 * Header name used to communicate the server-side response timestamp to clients.
 *
 * Clients can use this to detect stale cached responses or correlate
 * request timing without parsing the response body.
 */
export const RESPONSE_TIMESTAMP_HEADER = 'X-Response-Timestamp';

/**
 * Formats a Date as an ISO 8601 string suitable for use in HTTP headers.
 *
 * @param date - Defaults to `new Date()` (now)
 * @returns ISO 8601 UTC string, e.g. "2026-03-29T12:00:00.000Z"
 */
export function formatTimestampHeader(date: Date = new Date()): string {
   return date.toISOString();
}

/**
 * Attaches an `X-Response-Timestamp` header to the response.
 *
 * Call this before sending any public creator response so clients
 * receive a consistent, parseable timestamp on every reply.
 *
 * @param res - Express response object
 * @param date - Timestamp to attach; defaults to now
 *
 * @example
 * attachTimestampHeader(res);
 * sendSuccess(res, data);
 */
export function attachTimestampHeader(res: Response, date: Date = new Date()): void {
   res.set(RESPONSE_TIMESTAMP_HEADER, formatTimestampHeader(date));
}
