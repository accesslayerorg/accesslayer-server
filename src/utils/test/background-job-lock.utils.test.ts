import {
   acquireJobLock,
   releaseJobLock,
   resetJobLocks,
} from '../background-job-lock.utils';
import { logger } from '../logger.utils';

jest.mock('../../config', () => ({
   envConfig: {
      BACKGROUND_JOB_LOCK_TTL_MS: 1000,
   },
}));

jest.mock('../logger.utils', () => ({
   logger: {
      warn: jest.fn(),
   },
}));

describe('background-job-lock.utils', () => {
   beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      resetJobLocks();
      jest.clearAllMocks();
   });

   afterEach(() => {
      jest.useRealTimers();
      resetJobLocks();
   });

   it('acquires lock with default TTL from config', () => {
      const result = acquireJobLock({ name: 'indexer', owner: 'worker-a' });

      expect(result.acquired).toBe(true);
      expect(result.expiresAt).toBe('2026-01-01T00:00:01.000Z');
   });

   it('supports per-call TTL override', () => {
      const result = acquireJobLock({
         name: 'indexer',
         owner: 'worker-a',
         ttlMs: 5000,
      });

      expect(result.acquired).toBe(true);
      expect(result.expiresAt).toBe('2026-01-01T00:00:05.000Z');
   });

   it('rejects acquisition while active lock exists', () => {
      acquireJobLock({ name: 'indexer', owner: 'worker-a' });
      const result = acquireJobLock({ name: 'indexer', owner: 'worker-b' });

      expect(result).toEqual({
         acquired: false,
         holder: 'worker-a',
         expiresAt: '2026-01-01T00:00:01.000Z',
      });
   });

   it('logs expiration and allows lock reclaim after TTL', () => {
      acquireJobLock({ name: 'indexer', owner: 'worker-a' });
      jest.advanceTimersByTime(1001);

      const result = acquireJobLock({ name: 'indexer', owner: 'worker-b' });

      expect(result.acquired).toBe(true);
      expect(logger.warn).toHaveBeenCalledWith(
         expect.objectContaining({
            lockName: 'indexer',
            previousOwner: 'worker-a',
         }),
         'Background job lock expired; reclaiming lock'
      );
   });

   it('releases lock only when owner matches', () => {
      acquireJobLock({ name: 'indexer', owner: 'worker-a' });

      expect(releaseJobLock('indexer', 'worker-b')).toBe(false);
      expect(releaseJobLock('indexer', 'worker-a')).toBe(true);
   });
});
