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

/**
 * Truncate a string so its UTF-8 encoded byte length does not exceed maxBytes.
 *
 * Iterating by code point keeps surrogate pairs and multi-byte characters intact
 * while still enforcing byte-oriented database column limits.
 */
export function truncateToBytes(value: string, maxBytes: number): string {
   if (!Number.isFinite(maxBytes) || maxBytes < 0) {
      throw new RangeError('maxBytes must be a non-negative finite number');
   }

   if (Buffer.byteLength(value, 'utf8') <= maxBytes) {
      return value;
   }

   let byteLength = 0;
   let result = '';

   for (const char of value) {
      const charBytes = Buffer.byteLength(char, 'utf8');

      if (byteLength + charBytes > maxBytes) {
         break;
      }

      result += char;
      byteLength += charBytes;
   }

   return result;
}
