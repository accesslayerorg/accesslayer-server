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
 * Truncate a string to a maximum UTF-8 byte length, preserving character boundaries.
 */
export function truncateToBytes(value: string, maxBytes: number): string {
   if (!Number.isFinite(maxBytes) || maxBytes < 0) {
      throw new RangeError('maxBytes must be a non-negative finite number');
   }

   const encoder = new TextEncoder();
   const bytes = encoder.encode(value);

   if (bytes.length <= maxBytes) {
      return value;
   }

   let charLength = 0;
   let byteLength = 0;

   for (let i = 0; i < value.length; i++) {
      const char = value[i];
      const charBytes = encoder.encode(char).length;

      if (byteLength + charBytes > maxBytes) {
         break;
      }

      charLength++;
      byteLength += charBytes;
   }

   return value.slice(0, charLength);
}
