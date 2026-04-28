import { logger } from './logger.utils';

/**
 * Sanitizes the job payload for logging by removing or truncating sensitive/large data.
 * This prevents logging of potentially sensitive information or excessively large payloads.
 */
function sanitizePayload(payload: any): any {
  if (!payload) return payload;

  // If it's a string, truncate if too long
  if (typeof payload === 'string') {
    return payload.length > 500 ? `${payload.substring(0, 500)}...` : payload;
  }

  // If it's an array, sanitize each element and truncate if too long
  if (Array.isArray(payload)) {
    const sanitizedArray = payload.slice(0, 10).map(sanitizePayload);
    if (payload.length > 10) {
      sanitizedArray.push('...truncated');
    }
    return sanitizedArray;
  }

  // If it's an object, create a shallow copy and sanitize known sensitive fields
  if (typeof payload === 'object') {
    const sanitized = { ...payload };

    // Remove or mask potentially sensitive fields
    const sensitiveFields = ['password', 'token', 'secret', 'key', 'privateKey', 'apiKey'];
    sensitiveFields.forEach(field => {
      if (sanitized[field]) {
        sanitized[field] = '[REDACTED]';
      }
    });

    // Recursively sanitize nested objects and arrays
    Object.keys(sanitized).forEach(key => {
      if (typeof sanitized[key] === 'object' && sanitized[key] !== null) {
        sanitized[key] = sanitizePayload(sanitized[key]);
      }
    });

    return sanitized;
  }

  return payload;
}

/**
 * Logs retry exhaustion for indexer jobs.
 * This helper should be called when an indexer job has exhausted all retry attempts.
 *
 * @param jobId - Unique identifier for the job (e.g., job type or ID)
 * @param context - Additional context metadata (e.g., { workerId: 'worker-1', attempt: 3 })
 * @param payload - The job payload (will be sanitized before logging)
 * @param failureReason - Reason for the failure
 * @param errorDetails - Optional detailed error information
 */
export function logRetryExhaustion(
  jobId: string,
  context: Record<string, any>,
  payload: any,
  failureReason: string,
  errorDetails?: string
) {
  const sanitizedPayload = sanitizePayload(payload);

  logger.warn({
    msg: 'Indexer job retry exhaustion',
    jobId,
    context,
    payload: sanitizedPayload,
    failureReason,
    errorDetails,
  });
}