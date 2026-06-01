export function sanitizeBio(bio: string): string {
  let sanitized = bio;

  // Strip HTML tags
  sanitized = sanitized.replace(/<[^>]*>/g, '');

  // Remove invisible Unicode characters (zero-width spaces, control characters, etc.)
  // This includes:
  // - Control characters (C0 and C1) except for space (0x20), tab (0x09), line feed (0x0A), carriage return (0x0D)
  // - Zero-width spaces, joiners, non-joiners, etc.
  sanitized = sanitized.replace(/[\u0000-\u0008\u000B-\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200D\u2060\uFEFF]/g, '');

  // Normalize whitespace
  sanitized = sanitized.replace(/\s+/g, ' ').trim();

  return sanitized;
}
