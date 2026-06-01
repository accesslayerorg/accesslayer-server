import { PrismaClient } from '@prisma/client';
import { createHash } from 'crypto';
import { envConfig } from '../config';
import { requestContextStorage } from './als.utils';
import { logger } from './logger.utils';

// Use global variable to prevent multiple instances in development
declare global {
   var prisma: any | undefined;
}

/**
 * Replace all primitive leaf values in a Prisma args object with '?' so the
 * resulting structure identifies the query pattern without exposing any values.
 */
function normalizeArgsForFingerprint(value: unknown, depth = 0): unknown {
   if (depth > 8) return '?';
   if (value === null || value === undefined) return value;
   if (Array.isArray(value)) {
      return value.map((item) => normalizeArgsForFingerprint(item, depth + 1));
   }
   if (typeof value === 'object') {
      const sorted = Object.keys(value as object).sort();
      const result: Record<string, unknown> = {};
      for (const key of sorted) {
         result[key] = normalizeArgsForFingerprint(
            (value as Record<string, unknown>)[key],
            depth + 1
         );
      }
      return result;
   }
   return '?';
}

/**
 * Build a short deterministic hash that identifies the query pattern (model,
 * operation, and arg structure) without including any parameter values.
 */
function buildQueryFingerprint(
   model: string | undefined,
   operation: string,
   args: unknown
): string {
   const normalized = {
      model: model ?? 'unknown',
      operation,
      args: normalizeArgsForFingerprint(args),
   };
   return createHash('sha256')
      .update(JSON.stringify(normalized))
      .digest('hex')
      .slice(0, 16);
}

const basePrisma = new PrismaClient({
   log:
      envConfig.MODE === 'development'
         ? ['query', 'error', 'warn']
         : ['error'],
   datasourceUrl: envConfig.DATABASE_URL,
});

// Extend Prisma with query timeout and slow-query detection
export const prisma = basePrisma.$extends({
   query: {
      $allOperations({ operation, model, args, query }) {
         const timeoutMs = envConfig.DB_QUERY_TIMEOUT_MS;
         const slowThresholdMs = envConfig.SLOW_QUERY_THRESHOLD_MS;
         const context = requestContextStorage.getStore();

         let timeoutId: NodeJS.Timeout;
         let timedOut = false;

         const timeoutPromise = new Promise((_, reject) => {
            timeoutId = setTimeout(() => {
               timedOut = true;
               const logContext = {
                  type: 'database_timeout',
                  operation,
                  model,
                  timeoutMs,
                  path: context?.path,
                  method: context?.method,
                  requestId: context?.requestId,
               };
               logger.error(logContext, `Database query timed out after ${timeoutMs}ms`);
               reject(new Error(`Database query timed out after ${timeoutMs}ms`));
            }, timeoutMs);
         });

         const start = Date.now();
         const queryPromise = query(args).finally(() => {
            clearTimeout(timeoutId);
            if (!timedOut) {
               const elapsedMs = Date.now() - start;
               if (elapsedMs > slowThresholdMs) {
                  logger.warn(
                     {
                        type: 'slow_query',
                        model,
                        operation,
                        fingerprint: buildQueryFingerprint(model, operation, args),
                        elapsedMs,
                        thresholdMs: slowThresholdMs,
                        requestId: context?.requestId,
                     },
                     'Slow database query detected'
                  );
               }
            }
         });

         return Promise.race([queryPromise, timeoutPromise]);
      },
   },
});

// Prevent multiple instances in development environment
if (envConfig.MODE !== 'production') {
   global.prisma = prisma;
}
