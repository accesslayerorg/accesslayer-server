/**
 * Log field sanitization utility to prevent log injection attacks.
 *
 * Strips or escapes control characters (newlines, carriage returns, tabs, etc.)
 * from log field values to prevent injection into structured log streams.
 *
 * This is particularly important for user-supplied values like search terms,
 * handles, and filter parameters that could contain newline characters to
 * break log parsing.
 */

/**
 * Control characters that can break structured log parsing.
 * Includes: newline, carriage return, tab, form feed, vertical tab, null.
 */
const CONTROL_CHAR_PATTERN = /[\n\r\t\f\v\0]/g;

/**
 * Escape sequence map for control characters.
 * Maps control characters to their escaped representations.
 */
const ESCAPE_MAP: Record<string, string> = {
   '\n': '\\n',
   '\r': '\\r',
   '\t': '\\t',
   '\f': '\\f',
   '\v': '\\v',
   '\0': '\\0',
};

/**
 * Sanitizes a log field value by escaping control characters.
 *
 * Converts control characters to their escaped representations:
 * - Newline (\n) → \\n
 * - Carriage return (\r) → \\r
 * - Tab (\t) → \\t
 * - Form feed (\f) → \\f
 * - Vertical tab (\v) → \\v
 * - Null (\0) → \\0
 *
 * @param value - The log field value to sanitize
 * @returns Sanitized string with control characters escaped
 *
 * @example
 * sanitizeLogFieldValue('search\nterm') // Returns: 'search\\nterm'
 * sanitizeLogFieldValue('handle\rwith\rcarriage') // Returns: 'handle\\rwith\\rcarriage'
 * sanitizeLogFieldValue('normal string') // Returns: 'normal string'
 */
export function sanitizeLogFieldValue(value: unknown): string {
   if (value === null || value === undefined) {
      return '';
   }

   const str = String(value);
   return str.replace(CONTROL_CHAR_PATTERN, char => ESCAPE_MAP[char] || char);
}

/**
 * Sanitizes all string values in an object recursively.
 *
 * Walks through an object and applies sanitizeLogFieldValue to all string values,
 * leaving non-string values unchanged. Handles nested objects and arrays.
 *
 * @param obj - Object to sanitize
 * @returns New object with all string values sanitized
 *
 * @example
 * sanitizeLogObject({
 *   search: 'term\nwith\nnewlines',
 *   count: 42,
 *   nested: { handle: 'user\rname' }
 * })
 * // Returns:
 * // {
 * //   search: 'term\\nwith\\nnewlines',
 * //   count: 42,
 * //   nested: { handle: 'user\\rname' }
 * // }
 */
export function sanitizeLogObject(obj: unknown): unknown {
   if (obj === null || obj === undefined) {
      return obj;
   }

   if (typeof obj === 'string') {
      return sanitizeLogFieldValue(obj);
   }

   if (Array.isArray(obj)) {
      return obj.map(item => sanitizeLogObject(item));
   }

   if (typeof obj === 'object') {
      const sanitized: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
         sanitized[key] = sanitizeLogObject(value);
      }
      return sanitized;
   }

   return obj;
}
