import { logDbPoolAcquire, logDbPoolRelease } from './db-pool-log.utils';
import { logger } from './logger.utils';

jest.mock('./logger.utils', () => ({
   logger: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
   },
}));

describe('Database Connection Pool Event Logger (#764)', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   describe('logDbPoolAcquire', () => {
      it('emits a DEBUG log with pool_size, idle_count, wait_time_ms, and acquired_at fields', () => {
         const acquiredAt = new Date('2026-08-25T10:00:00.000Z');
         logDbPoolAcquire({
            poolSize: 10,
            idleCount: 7,
            waitTimeMs: 25,
            acquiredAt,
         });

         expect(logger.debug).toHaveBeenCalledTimes(1);
         expect(logger.info).not.toHaveBeenCalled();
         expect(logger.warn).not.toHaveBeenCalled();

         const [logPayload, message] = (logger.debug as jest.Mock).mock
            .calls[0];
         expect(message).toBe('Database connection acquired');
         expect(logPayload).toMatchObject({
            event: 'db_pool_acquire',
            pool_size: 10,
            idle_count: 7,
            wait_time_ms: 25,
            acquired_at: acquiredAt.toISOString(),
         });
      });

      it('formats acquired_at as an ISO 8601 string when given a Date object', () => {
         const now = new Date();
         logDbPoolAcquire({
            poolSize: 15,
            idleCount: 14,
            waitTimeMs: 5,
            acquiredAt: now,
         });

         const [logPayload] = (logger.debug as jest.Mock).mock.calls[0];
         expect(logPayload.acquired_at).toBe(now.toISOString());
      });

      it('uses string timestamp as acquired_at directly if provided as string', () => {
         const isoStr = '2026-08-25T12:34:56.789Z';
         logDbPoolAcquire({
            poolSize: 5,
            idleCount: 2,
            waitTimeMs: 10,
            acquiredAt: isoStr,
         });

         const [logPayload] = (logger.debug as jest.Mock).mock.calls[0];
         expect(logPayload.acquired_at).toBe(isoStr);
      });

      it('does NOT emit a WARN log when wait_time_ms is below 1000ms', () => {
         logDbPoolAcquire({
            poolSize: 10,
            idleCount: 9,
            waitTimeMs: 500,
         });

         expect(logger.debug).toHaveBeenCalledTimes(1);
         expect(logger.warn).not.toHaveBeenCalled();
      });

      it('boundary test: does NOT emit a WARN log at exactly 1000ms wait_time_ms', () => {
         logDbPoolAcquire({
            poolSize: 10,
            idleCount: 5,
            waitTimeMs: 1000,
         });

         expect(logger.debug).toHaveBeenCalledTimes(1);
         expect(logger.warn).not.toHaveBeenCalled();
      });

      it('boundary test: DOES emit a WARN log at 1001ms wait_time_ms (>1000ms threshold)', () => {
         const acquiredAt = new Date('2026-08-25T10:00:00.000Z');
         logDbPoolAcquire({
            poolSize: 10,
            idleCount: 2,
            waitTimeMs: 1001,
            acquiredAt,
         });

         expect(logger.debug).toHaveBeenCalledTimes(1);
         expect(logger.warn).toHaveBeenCalledTimes(1);

         const [warnPayload, warnMsg] = (logger.warn as jest.Mock).mock
            .calls[0];
         expect(warnMsg).toContain('1001ms');
         expect(warnMsg).toContain('1000ms threshold');
         expect(warnPayload).toMatchObject({
            event: 'db_pool_wait_warning',
            pool_size: 10,
            idle_count: 2,
            wait_time_ms: 1001,
            acquired_at: acquiredAt.toISOString(),
         });
      });

      it('emits a WARN log when wait_time_ms is significantly higher than 1000ms (e.g. 2500ms)', () => {
         logDbPoolAcquire({
            poolSize: 10,
            idleCount: 0,
            waitTimeMs: 2500,
         });

         expect(logger.debug).toHaveBeenCalledTimes(1);
         expect(logger.warn).toHaveBeenCalledTimes(1);

         const [warnPayload] = (logger.warn as jest.Mock).mock.calls[0];
         expect(warnPayload.wait_time_ms).toBe(2500);
      });

      it('emits normal path events at DEBUG level, not INFO level', () => {
         logDbPoolAcquire({
            poolSize: 10,
            idleCount: 8,
            waitTimeMs: 10,
         });

         expect(logger.info).not.toHaveBeenCalled();
         expect(logger.debug).toHaveBeenCalledTimes(1);
      });
   });

   describe('logDbPoolRelease', () => {
      it('emits a DEBUG log with pool_size, idle_count, and held_for_ms fields', () => {
         logDbPoolRelease({
            poolSize: 10,
            idleCount: 10,
            heldForMs: 150,
         });

         expect(logger.debug).toHaveBeenCalledTimes(1);
         expect(logger.info).not.toHaveBeenCalled();
         expect(logger.warn).not.toHaveBeenCalled();

         const [logPayload, message] = (logger.debug as jest.Mock).mock
            .calls[0];
         expect(message).toBe('Database connection released');
         expect(logPayload).toMatchObject({
            event: 'db_pool_release',
            pool_size: 10,
            idle_count: 10,
            held_for_ms: 150,
         });
      });

      it('emits normal path release events at DEBUG level, not INFO level', () => {
         logDbPoolRelease({
            poolSize: 20,
            idleCount: 15,
            heldForMs: 45,
         });

         expect(logger.info).not.toHaveBeenCalled();
         expect(logger.debug).toHaveBeenCalledTimes(1);
      });
   });
});
