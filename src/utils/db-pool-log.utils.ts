import { logger } from './logger.utils';
import { buildLogFields } from './log-fields.utils';

export interface DbPoolAcquireLogFields {
   poolSize: number;
   idleCount: number;
   waitTimeMs: number;
   acquiredAt?: Date | string;
}

export interface DbPoolReleaseLogFields {
   poolSize: number;
   idleCount: number;
   heldForMs: number;
}

/**
 * Emits a structured log when a database connection is acquired from the pool.
 * Normal acquisitions emit a DEBUG level log with pool_size, idle_count, wait_time_ms, and acquired_at.
 * If waitTimeMs > 1000, a WARN level log is also emitted.
 */
export function logDbPoolAcquire(fields: DbPoolAcquireLogFields): void {
   const acquiredAtISO =
      fields.acquiredAt instanceof Date
         ? fields.acquiredAt.toISOString()
         : typeof fields.acquiredAt === 'string'
           ? fields.acquiredAt
           : new Date().toISOString();

   const logPayload = buildLogFields({
      event: 'db_pool_acquire',
      pool_size: fields.poolSize,
      idle_count: fields.idleCount,
      wait_time_ms: fields.waitTimeMs,
      acquired_at: acquiredAtISO,
   });

   logger.debug(logPayload, 'Database connection acquired');

   if (fields.waitTimeMs > 1000) {
      logger.warn(
         buildLogFields({
            event: 'db_pool_wait_warning',
            pool_size: fields.poolSize,
            idle_count: fields.idleCount,
            wait_time_ms: fields.waitTimeMs,
            acquired_at: acquiredAtISO,
         }),
         `Database connection pool wait time (${fields.waitTimeMs}ms) exceeded 1000ms threshold`
      );
   }
}

/**
 * Emits a structured DEBUG log when a database connection is released back to the pool.
 */
export function logDbPoolRelease(fields: DbPoolReleaseLogFields): void {
   const logPayload = buildLogFields({
      event: 'db_pool_release',
      pool_size: fields.poolSize,
      idle_count: fields.idleCount,
      held_for_ms: fields.heldForMs,
   });

   logger.debug(logPayload, 'Database connection released');
}
