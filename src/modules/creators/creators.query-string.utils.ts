import { z, ZodTypeAny } from 'zod';

/**
 * Trims supported creator list query string inputs before validation.
 *
 * - String values: leading/trailing whitespace removed; whitespace-only becomes `undefined`
 *   so optional defaults apply consistently with omitted params.
 * - `null` / `undefined`: passed through as `undefined`.
 * - Other types: returned unchanged (downstream Zod rules apply).
 *
 * Scope is intentionally narrow: no case folding, collapsing, or handle normalization here.
 */
export function normalizeCreatorListQueryStringValue(value: unknown): unknown {
   if (value === null || value === undefined) {
      return undefined;
   }
   if (typeof value !== 'string') {
      return value;
   }
   const trimmed = value.trim();
   return trimmed === '' ? undefined : trimmed;
}

/**
 * Wraps a Zod schema with {@link normalizeCreatorListQueryStringValue} preprocessing.
 * Use for creator list string query fields shared across list endpoints.
 */
export function withCreatorListQueryStringNormalization<T extends ZodTypeAny>(
   schema: T
) {
   return z.preprocess(normalizeCreatorListQueryStringValue, schema);
}
