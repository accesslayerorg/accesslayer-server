import { createHash } from 'crypto';

/**
 * Sensitive field patterns that should be excluded from query signatures.
 * These patterns match field names that might contain PII, tokens, or other sensitive data.
 */
const SENSITIVE_FIELD_PATTERNS = [
   'password',
   'token',
   'secret',
   'key',
   'auth',
   'credential',
   'email',
   'phone',
   'ssn',
   'credit',
   'card',
] as const;

/**
 * Check if a field name matches any sensitive pattern.
 * Case-insensitive matching to catch variations like 'Password', 'AUTH_TOKEN', etc.
 */
function isSensitiveField(fieldName: string): boolean {
   const lowerField = fieldName.toLowerCase();
   return SENSITIVE_FIELD_PATTERNS.some(pattern => lowerField.includes(pattern));
}

/**
 * Builds a deterministic query signature for cache diagnostics.
 *
 * This function creates a stable hash of query parameters that can be used
 * to identify equivalent requests for caching purposes. Sensitive fields
 * are excluded to prevent leaking credentials in logs.
 *
 * @param query - The query parameters object
 * @returns A SHA-256 hash string representing the normalized query
 *
 * @example
 * ```ts
 * const signature = buildQuerySignature({
 *   limit: 20,
 *   search: 'example',
 *   token: 'secret123' // This will be excluded
 * });
 * // Returns: 'a1b2c3d4...' (deterministic hash)
 * ```
 */
export function buildQuerySignature(query: Record<string, unknown>): string {
   // Filter out sensitive fields
   const safeEntries = Object.entries(query).filter(([key]) => !isSensitiveField(key));

   // Sort keys alphabetically for deterministic ordering
   safeEntries.sort(([a], [b]) => a.localeCompare(b));

   // Create a normalized string representation
   const normalized = safeEntries.map(([key, value]) => `${key}:${JSON.stringify(value)}`).join('|');

   // Generate SHA-256 hash
   return createHash('sha256').update(normalized).digest('hex');
}