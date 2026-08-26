import pino from 'pino';
import os from 'os';
import { requestContextStorage } from './als.utils';

const isDevelopment = process.env.MODE === 'development';

/**
 * Structured application logger.
 *
 * - Development: pretty-printed, colorized, human-readable output via pino-pretty.
 * - Test / production: newline-delimited JSON with `timestamp`, `level`,
 *   and (when available) `traceId`.
 *
 * The `mixin` pulls the current request's trace ID out of AsyncLocalStorage
 * so every log call made anywhere in a request's call stack — middleware,
 * service, or database layer — carries the same `traceId` without having to
 * be threaded through function arguments.
 */
export const logger = pino({
   level: process.env.LOG_LEVEL || 'info',
   timestamp: pino.stdTimeFunctions.isoTime,
   base: { pid: process.pid, hostname: os.hostname() },
   mixin() {
      const traceId = requestContextStorage.getStore()?.traceId;
      return traceId ? { traceId } : {};
   },
   transport: isDevelopment
      ? {
           target: 'pino-pretty',
           options: {
              colorize: true,
              translateTime: 'SYS:standard',
              ignore: 'pid,hostname',
           },
        }
      : undefined,
});

export const HTTP_STATUS = {
   OK: 200,
   CREATED: 201,
   NO_CONTENT: 204,

   BAD_REQUEST: 400,
   UNAUTHORIZED: 401,
   FORBIDDEN: 403,
   NOT_FOUND: 404,
   CONFLICT: 409,

   INTERNAL_SERVER_ERROR: 500,
} as const;
