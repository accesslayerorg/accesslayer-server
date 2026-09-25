/**
 * Normalizes a flat key-value param map into a canonical sorted order
 * before cache key generation.
 *
 * Two requests with the same parameters in different orders produce the
 * same canonical string, preventing duplicate cache entries.
 *
 * @param params - Object whose keys are param names and values are their
 *   serialized representations. `undefined` values are omitted.
 * @returns A colon-delimited string: `"key1:val1:key2:val2:..."` where
 *   keys are sorted lexicographically.
 *
 * @example
 * buildCanonicalParamString({ order: 'desc', limit: '20', sort: 'createdAt' })
 * // => "limit:20:order:desc:sort:createdAt"
 */
export function buildCanonicalParamString(
   params: Record<string, unknown>
): string {
   return Object.entries(params)
      .filter((entry): entry is [string, unknown] => entry[1] !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
         ([key, value]) =>
            `${key}:${typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)}`
      )
      .join(':');
}

import { createHash } from 'crypto';

/**
 * Generates a stable, fixed-length cache key from a base string and query parameter set.
 *
 * Param keys are sorted lexicographically before hashing, ensuring that parameter order
 * does not affect the generated key.
 *
 * @param base - The base prefix string (e.g. creator ID or endpoint prefix)
 * @param params - Object containing query parameter key-value pairs
 * @returns A fixed-length string cache key
 */
export function buildCacheKey(
   base: string,
   params: Record<string, unknown>
): string {
   const canonical = buildCanonicalParamString(params);
   const hash = createHash('sha256')
      .update(canonical)
      .digest('hex')
      .slice(0, 16);
   return `${base}:${hash}`;
}
