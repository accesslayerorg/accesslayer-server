import { createHash } from 'crypto';
import { Response } from 'express';

export const CREATOR_ETAG_HEADER = 'ETag';

/**
 * Computes an RFC-compliant strong ETag from the given data.
 * The data is deterministically serialised before hashing so that
 * identical payloads always produce the same ETag regardless of
 * object key insertion order.
 *
 * @param data - Any JSON-serialisable value
 * @returns A quoted strong ETag string, e.g. `"abc123..."`
 */
export function computeCreatorETag(data: unknown): string {
   const hash = createHash('sha256')
      .update(JSON.stringify(data))
      .digest('hex');
   return `"${hash}"`;
}

/**
 * Attaches an ETag header to the Express response.
 *
 * Accepts either a pre-computed ETag string (already quoted) or raw data
 * to hash. Leaves other cache-related headers untouched so the helper
 * composes cleanly with existing cache-control middleware.
 *
 * @param res - Express response object
 * @param etagOrData - A pre-computed ETag string or the response data to hash
 *
 * @example
 * // From data:
 * attachCreatorETagHeader(res, creatorList);
 *
 * @example
 * // Pre-computed:
 * attachCreatorETagHeader(res, '"abc123"');
 */
export function attachCreatorETagHeader(res: Response, etagOrData: string | unknown): void {
   const etag =
      typeof etagOrData === 'string' && /^"[^"]*"$/.test(etagOrData)
         ? etagOrData
         : computeCreatorETag(etagOrData);
   res.set(CREATOR_ETAG_HEADER, etag);
}
