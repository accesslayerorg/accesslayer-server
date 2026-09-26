export const DISPLAY_NAME_MAX_LENGTH = 50;

export type DisplayNameValidationError =
   | 'display_name_too_long'
   | 'display_name_empty';

export type DisplayNameSanitizeResult =
   | { success: true; data: string }
   | { success: false; error: DisplayNameValidationError };

/**
 * Strips HTML tags from display name, removes invisible Unicode characters, and trims whitespace.
 *
 * @param displayName - The raw display name input string.
 * @returns The sanitized display name with HTML tags stripped and whitespace normalized.
 */
export function sanitizeDisplayName(displayName: string): string {
   if (typeof displayName !== 'string') {
      return '';
   }

   let sanitized = displayName;

   // Strip HTML tags (e.g. <script>alert(1)</script> -> alert(1))
   sanitized = sanitized.replace(/<[^>]*>/g, '');

   // Remove invisible Unicode characters (zero-width spaces, control characters, etc.)
   sanitized = sanitized.replace(
      /[\u0000-\u0008\u000B-\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200D\u2060\uFEFF]/g,
      ''
   );

   // Normalize whitespace and trim
   sanitized = sanitized.replace(/\s+/g, ' ').trim();

   return sanitized;
}

/**
 * Sanitizes and validates a creator display name against persistence requirements.
 *
 * Rules:
 * 1. HTML tags are stripped and whitespace is normalized/trimmed.
 * 2. If the resulting sanitized name is empty, fails with 'display_name_empty'.
 * 3. If the resulting sanitized name exceeds 50 characters, fails with 'display_name_too_long'.
 * 4. Otherwise, succeeds with the sanitized name string.
 *
 * @param displayName - The raw display name input string.
 * @returns DisplayNameSanitizeResult object indicating success or specific validation error.
 */
export function sanitizeAndValidateDisplayName(
   displayName: string
): DisplayNameSanitizeResult {
   const sanitized = sanitizeDisplayName(displayName);

   if (sanitized.length === 0) {
      return { success: false, error: 'display_name_empty' };
   }

   if (sanitized.length > DISPLAY_NAME_MAX_LENGTH) {
      return { success: false, error: 'display_name_too_long' };
   }

   return { success: true, data: sanitized };
}

/**
 * Helper function that validates and sanitizes a display name, throwing an Error with code if invalid.
 *
 * @param displayName - The raw display name string.
 * @returns The sanitized display name.
 * @throws Error with message/code 'display_name_empty' or 'display_name_too_long' if invalid.
 */
export function validateDisplayName(displayName: string): string {
   const result = sanitizeAndValidateDisplayName(displayName);
   if (!result.success) {
      const err = new Error(result.error);
      (err as any).code = result.error;
      throw err;
   }
   return result.data;
}
