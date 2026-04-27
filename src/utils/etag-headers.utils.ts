// src/utils/etag-headers.utils.ts
// Centralizes ETag header generation and attachment for public creator endpoints.

import { Response } from 'express';
import crypto from 'crypto';

/**
 * Generates a strong ETag for a given input.
 * Uses MD5 as it is fast and suitable for generating unique content identifiers.
 * 
 * @param input - The data to hash (string or JSON-serializable object).
 * @returns A quoted ETag string, e.g., "1a2b3c4d5e6f"
 */
export function generateETag(input: string | object): string {
   const content = typeof input === 'string' ? input : JSON.stringify(input);
   const hash = crypto.createHash('md5').update(content).digest('hex');
   return `"${hash}"`;
}

/**
 * Attaches an `ETag` header to the response.
 * 
 * This helper supports both pre-computed ETag values and automatic computation
 * from data objects. It works alongside existing cache-control headers to
 * facilitate conditional GET requests.
 * 
 * @param res - Express response object
 * @param value - Literal ETag string (quoted/weak) or object to be hashed
 * 
 * @example
 * // Compute ETag from response body
 * attachETagHeader(res, creatorProfile);
 * 
 * @example
 * // Use a pre-computed version or timestamp
 * attachETagHeader(res, profile.updatedAt.toISOString());
 */
export function attachETagHeader(res: Response, value: string | object): void {
   // If the value is already a quoted string or a weak ETag, use it directly.
   // Otherwise, generate a hash from the input.
   const etag =
      typeof value === 'string' && (value.startsWith('"') || value.startsWith('W/"'))
         ? value
         : generateETag(value);

   res.set('ETag', etag);
}