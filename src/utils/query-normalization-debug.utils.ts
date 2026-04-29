// src/utils/query-normalization-debug.utils.ts
// Debug helper for emitting normalized query snapshots for diagnostics.
// Only active when logger is set to debug level to avoid performance impact.

import { logger } from './logger.utils';

/**
 * Fields that should be sanitized to avoid leaking sensitive data in debug logs.
 * Add field names here that might contain PII, tokens, or other sensitive values.
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
 * Sanitization marker for sensitive values in debug output.
 */
const SANITIZED_VALUE = '[REDACTED]';

/**
 * Check if a field name matches any sensitive pattern.
 * Case-insensitive matching to catch variations like 'Password', 'AUTH_TOKEN', etc.
 */
function isSensitiveField(fieldName: string): boolean {
   const lowerField = fieldName.toLowerCase();
   return SENSITIVE_FIELD_PATTERNS.some(pattern => lowerField.includes(pattern));
}

/**
 * Recursively sanitize an object by replacing sensitive field values.
 * 
 * @param obj - Object to sanitize
 * @returns Sanitized copy of the object
 */
function sanitizeObject(obj: unknown): unknown {
   if (obj === null || obj === undefined) {
      return obj;
   }

   if (Array.isArray(obj)) {
      return obj.map(item => sanitizeObject(item));
   }

   if (typeof obj === 'object') {
      const sanitized: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
         if (isSensitiveField(key)) {
            sanitized[key] = SANITIZED_VALUE;
         } else {
            sanitized[key] = sanitizeObject(value);
         }
      }
      return sanitized;
   }

   return obj;
}

/**
 * Query normalization debug snapshot data.
 */
export interface QueryNormalizationSnapshot {
   /** Original raw query before normalization */
   raw: unknown;
   /** Normalized query after parsing and transformation */
   normalized: unknown;
   /** Whether the query passed validation */
   valid: boolean;
   /** Validation errors if any */
   errors?: Array<{ field: string; message: string }>;
   /** Timestamp of the snapshot */
   timestamp: string;
   /** Optional context label for identifying the query source */
   context?: string;
}

/**
 * Emit a debug snapshot of query normalization results.
 * 
 * This helper is only active when the logger level is set to 'debug' or lower.
 * It sanitizes sensitive fields before logging to prevent data leakage.
 * 
 * Use this to diagnose query parsing issues, understand normalization behavior,
 * or validate that query transformations are working as expected.
 * 
 * @param snapshot - Query normalization snapshot data
 * 
 * @example
 * // In a query parser
 * const parsed = parsePublicQuery(schema, rawQuery);
 * emitQueryNormalizationDebug({
 *   raw: rawQuery,
 *   normalized: parsed.ok ? parsed.data : null,
 *   valid: parsed.ok,
 *   errors: parsed.ok ? undefined : parsed.details,
 *   context: 'creator-list-query',
 * });
 */
export function emitQueryNormalizationDebug(
   snapshot: Omit<QueryNormalizationSnapshot, 'timestamp'>
): void {
   // Only emit debug logs if logger is at debug level
   if (!logger.isLevelEnabled('debug')) {
      return;
   }

   const sanitizedSnapshot: QueryNormalizationSnapshot = {
      raw: sanitizeObject(snapshot.raw),
      normalized: sanitizeObject(snapshot.normalized),
      valid: snapshot.valid,
      errors: snapshot.errors,
      timestamp: new Date().toISOString(),
      context: snapshot.context,
   };

   logger.debug({
      msg: 'Query normalization debug snapshot',
      queryNormalization: sanitizedSnapshot,
   });
}

/**
 * Create a query normalization debug emitter with a fixed context label.
 * 
 * This is useful for creating a reusable debug helper for a specific endpoint
 * or query type without repeating the context label.
 * 
 * @param context - Context label for all snapshots from this emitter
 * @returns Function that emits debug snapshots with the fixed context
 * 
 * @example
 * const debugCreatorQuery = createQueryDebugEmitter('creator-list');
 * 
 * // Later in code
 * debugCreatorQuery({
 *   raw: req.query,
 *   normalized: validatedQuery,
 *   valid: true,
 * });
 */
export function createQueryDebugEmitter(context: string) {
   return (snapshot: Omit<QueryNormalizationSnapshot, 'timestamp' | 'context'>) => {
      emitQueryNormalizationDebug({ ...snapshot, context });
   };
}
