export type TimestampInput = Date | string | number;

/**
 * Formats API response timestamps as UTC ISO 8601 strings with milliseconds.
 */
export function formatIsoTimestamp(value: TimestampInput): string {
   const date = value instanceof Date ? value : new Date(value);

   if (Number.isNaN(date.getTime())) {
      throw new RangeError('Invalid timestamp value');
   }

   return date.toISOString();
}

/**
 * Typed error thrown when a string cannot be parsed as an ISO 8601 timestamp.
 *
 * Only thrown by {@link parseISOTimestamp}. Callers may use `instanceof
 * InvalidTimestamp` to distinguish this error from other runtime failures.
 */
export class InvalidTimestamp extends Error {
   constructor(value: string) {
      super(`Invalid ISO 8601 timestamp: "${value}"`);
      this.name = 'InvalidTimestamp';
      // Maintains correct prototype chain when compiled to ES5.
      Object.setPrototypeOf(this, new.target.prototype);
   }
}

/**
 * ISO 8601 datetime pattern.
 *
 * Requires the full date portion (YYYY-MM-DD), a T separator, a time portion,
 * and a timezone designator (Z or ±HH:MM).  Bare Unix timestamp strings like
 * "1704153845000" are intentionally rejected.
 */
const ISO_8601_PATTERN =
   /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Parses a strict ISO 8601 datetime string into a UTC `Date` object.
 *
 * Accepts strings of the form `YYYY-MM-DDTHH:mm:ss[.sss](Z|±HH:MM)`.
 * Rejects empty strings, plain date strings (`2024-01-01`), and Unix
 * timestamp strings (`"1704153845000"`).
 *
 * @param value - The string to parse.
 * @returns A `Date` object representing the parsed UTC instant.
 * @throws {InvalidTimestamp} If `value` is not a valid ISO 8601 datetime string.
 *
 * @example
 * parseISOTimestamp('2024-01-02T03:04:05.678Z');
 * // => Date { 2024-01-02T03:04:05.678Z }
 *
 * parseISOTimestamp('not-a-date');
 * // throws InvalidTimestamp
 */
export function parseISOTimestamp(value: string): Date {
   if (!ISO_8601_PATTERN.test(value)) {
      throw new InvalidTimestamp(value);
   }

   const date = new Date(value);

   // Guard against ISO-shaped strings that produce an invalid Date.
   if (Number.isNaN(date.getTime())) {
      throw new InvalidTimestamp(value);
   }

   return date;
}
