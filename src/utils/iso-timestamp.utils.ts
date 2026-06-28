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
