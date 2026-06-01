// src/utils/safe-nested-read.utils.ts
// Helper for safely reading nested optional fields from response objects.
//
// Accessing nested optional fields requires repeated null checks that clutter
// handler code. This helper safely reads a nested optional field and returns
// a typed default when the field is null or absent.

/**
 * Safely read a nested optional field from an object.
 * Returns the field value if present, otherwise returns the provided default.
 *
 * @param obj - The object to read from (may be null or undefined)
 * @param path - Array of keys representing the path to the nested field
 * @param defaultValue - Value to return if the field is null, undefined, or path is invalid
 * @returns The field value if present, otherwise the default value
 *
 * @example
 * const creator = { profile: { social: { twitter: '@user' } } };
 * safeNestedRead(creator, ['profile', 'social', 'twitter'], 'N/A'); // '@user'
 * safeNestedRead(creator, ['profile', 'social', 'instagram'], 'N/A'); // 'N/A'
 * safeNestedRead(null, ['profile', 'social', 'twitter'], 'N/A'); // 'N/A'
 */
export function safeNestedRead<T>(
   obj: any,
   path: string[],
   defaultValue: T
): T {
   if (obj == null || !Array.isArray(path) || path.length === 0) {
      return defaultValue;
   }

   let current = obj;

   for (const key of path) {
      if (current == null || typeof current !== 'object') {
         return defaultValue;
      }
      current = current[key];
   }

   return current ?? defaultValue;
}

/**
 * Safely read a single-level optional field from an object.
 * Convenience wrapper for safeNestedRead with a single key.
 *
 * @param obj - The object to read from (may be null or undefined)
 * @param key - The field key to read
 * @param defaultValue - Value to return if the field is null or undefined
 * @returns The field value if present, otherwise the default value
 *
 * @example
 * const creator = { displayName: 'Alice', bio: null };
 * safeRead(creator, 'displayName', 'Unknown'); // 'Alice'
 * safeRead(creator, 'bio', 'No bio'); // 'No bio'
 * safeRead(creator, 'avatarUrl', 'default.png'); // 'default.png'
 */
export function safeRead<T>(obj: any, key: string, defaultValue: T): T {
   return safeNestedRead(obj, [key], defaultValue);
}
