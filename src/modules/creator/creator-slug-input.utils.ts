import { z, ZodTypeAny } from 'zod';

/**
 * Normalizes creator slug route input before validation.
 *
 * Scope is intentionally narrow:
 * - exact empty-string input becomes `undefined`
 * - `null` / `undefined` become `undefined`
 * - all other values pass through unchanged
 *
 * This lets creator route schemas treat empty-string slug params the same way
 * as omitted params without introducing broader slug rewriting behavior.
 */
export function normalizeCreatorSlugEmptyString(value: unknown): unknown {
   if (value === null || value === undefined) {
      return undefined;
   }

   if (typeof value === 'string' && value.trim() === '') {
      return undefined;
   }

   return value;
}

/**
 * Wraps a Zod schema with {@link normalizeCreatorSlugEmptyString} preprocessing.
 *
 * Use for creator route params that may receive slug-shaped input from HTTP
 * layers before the actual route schema runs.
 */
export function withCreatorSlugEmptyStringNormalization<T extends ZodTypeAny>(
   schema: T
) {
   return z.preprocess(normalizeCreatorSlugEmptyString, schema);
}
