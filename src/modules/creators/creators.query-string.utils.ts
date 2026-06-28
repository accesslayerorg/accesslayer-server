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

const UNRESERVED_QUERY_VALUE_PATTERN = /^[A-Za-z0-9._~-]$/;
const HEX_PAIR_PATTERN = /^[0-9A-Fa-f]{2}$/;

/**
 * Percent-encodes a creator query string value for safe logging or forwarding.
 *
 * Existing percent-encoded sequences are preserved as-is so already encoded
 * values are not double-encoded.
 */
export function encodeCreatorListQueryStringValue(
   value: string | null | undefined
): string | undefined {
   if (typeof value !== 'string') {
      return undefined;
   }

   let encoded = '';

   for (let index = 0; index < value.length; ) {
      const currentChar = value[index];

      if (
         currentChar === '%' &&
         index + 2 < value.length &&
         HEX_PAIR_PATTERN.test(value.slice(index + 1, index + 3))
      ) {
         encoded += value.slice(index, index + 3);
         index += 3;
         continue;
      }

      const codePoint = value.codePointAt(index);
      const char = String.fromCodePoint(codePoint ?? 0);

      if (UNRESERVED_QUERY_VALUE_PATTERN.test(char)) {
         encoded += char;
      } else {
         encoded += encodeURIComponent(char);
      }

      index += char.length;
   }

   return encoded;
}
