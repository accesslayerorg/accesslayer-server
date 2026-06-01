// src/utils/request-context-hash.utils.ts
// Produces a short deterministic hash of safe (non-sensitive) request context
// fields so log entries from the same logical operation share a stable tag.
import crypto from 'crypto';
import { Request } from 'express';

/**
 * Compute a short SHA-256 hex digest from safe request context fields.
 *
 * Fields included (non-sensitive, stable per endpoint):
 *  - HTTP method
 *  - URL path without query string
 *  - `content-type` request header (if present)
 *
 * Fields deliberately excluded:
 *  - Authorization / Cookie headers
 *  - Request body
 *  - Query string (contains user-supplied values)
 *  - Full URL (includes query string)
 *
 * The digest is truncated to 12 hex characters (48 bits) — enough for
 * trace correlation without bloating log lines.
 *
 * @param req - Express Request object
 * @returns 12-character lowercase hex string
 *
 * @example
 * // GET /api/creators?page=1
 * computeRequestContextHash(req) // e.g. "3a9f1c2b4e7d"
 */
export function computeRequestContextHash(req: Request): string {
  const path = (req.path || '/').split('?')[0];
  const contentType = (req.headers['content-type'] ?? '').split(';')[0].trim();

  const payload = [req.method.toUpperCase(), path, contentType].join('\x00');

  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 12);
}
