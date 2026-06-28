import { sanitizeLogFieldValue, sanitizeLogObject } from './log-field-sanitizer.utils';
import { logger } from './logger.utils';

export interface IndexerRetryExhaustionContext {
   jobId: string;
   jobType: string;
   retryCount: number;
   lastError?: string;
   payload?: unknown;
}

/**
 * Logs a structured error entry when an indexer job exhausts its retry budget.
 *
 * String fields are sanitised to escape control characters and prevent log
 * injection. The job payload, when present, is recursively sanitised before
 * it is written so that untrusted field content cannot break log parsing.
 *
 * @param ctx - Job identity and context metadata
 */
export function logIndexerRetryExhaustion(ctx: IndexerRetryExhaustionContext): void {
   logger.error({
      msg: 'Indexer job retry limit exhausted',
      jobId: sanitizeLogFieldValue(ctx.jobId),
      jobType: sanitizeLogFieldValue(ctx.jobType),
      retryCount: ctx.retryCount,
      ...(ctx.lastError !== undefined && { lastError: sanitizeLogFieldValue(ctx.lastError) }),
      ...(ctx.payload !== undefined && { payload: sanitizeLogObject(ctx.payload) }),
   });
}
