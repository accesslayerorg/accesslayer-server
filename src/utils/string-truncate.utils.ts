/**
 * Truncate a string to a maximum character length without changing shorter values.
 *
 * This is intentionally simple and deterministic so callers can keep data within
 * a known storage or display limit before writing to persistence layers.
 */
export function truncateString(value: string, maxLength: number): string {
   if (!Number.isFinite(maxLength) || maxLength < 0) {
      throw new RangeError('maxLength must be a non-negative finite number');
   }

   if (value.length <= maxLength) {
      return value;
   }

   return value.slice(0, maxLength);
}
