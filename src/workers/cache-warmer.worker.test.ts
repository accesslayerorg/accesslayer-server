import { CACHE_WARM_INTERVAL_MS } from '../config/cache-warm';
import {
   getCacheWarmMetrics,
   resetCacheWarmMetrics,
} from '../utils/cache-warm-metrics.utils';
import {
   CacheWarmerWorker,
   CacheWarmerWorkerOptions,
} from './cache-warmer.worker';

jest.mock('../utils/logger.utils', () => ({
   logger: {
      error: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
   },
}));

import { logger } from '../utils/logger.utils';

const mockLogger = logger as jest.Mocked<typeof logger>;

function createTarget(
   name: string,
   remainingTtlMs: number | null,
   warm: jest.Mock = jest.fn().mockResolvedValue(undefined)
) {
   return {
      name,
      cacheKey: () => `cache:${name}`,
      ttlMs: 100,
      getRemainingTtlMs: jest.fn().mockResolvedValue(remainingTtlMs),
      warm,
   };
}

function createWorker(
   targets: ReturnType<typeof createTarget>[],
   options: Partial<CacheWarmerWorkerOptions> = {}
): CacheWarmerWorker {
   return new CacheWarmerWorker({
      targets,
      random: () => 0,
      sleep: async () => {},
      ...options,
   });
}

async function flushMicrotasks(): Promise<void> {
   for (let i = 0; i < 12; i += 1) {
      await Promise.resolve();
   }
}

describe('CacheWarmerWorker', () => {
   beforeEach(() => {
      resetCacheWarmMetrics();
      jest.clearAllMocks();
   });

   afterEach(() => {
      jest.useRealTimers();
   });

   it('skips an entry with more than half of its TTL remaining', async () => {
      const target = createTarget('fresh', 51);

      await createWorker([target]).runCycle();

      expect(target.warm).not.toHaveBeenCalled();
      expect(getCacheWarmMetrics().cache_warm_duration_seconds.samples).toEqual(
         []
      );
   });

   it.each([50, 25])(
      'warms when %i ms or less of the TTL remains',
      async remaining => {
         const target = createTarget('stale', remaining);

         await createWorker([target]).runCycle();

         expect(target.warm).toHaveBeenCalledTimes(1);
      }
   );

   it.each([0, null])('warms when the remaining TTL is %s', async remaining => {
      const target = createTarget('missing', remaining);

      await createWorker([target]).runCycle();

      expect(target.warm).toHaveBeenCalledTimes(1);
   });

   it('isolates a failed target and records only its failure', async () => {
      const failed = createTarget(
         'failed',
         0,
         jest.fn().mockRejectedValue(new Error('database unavailable'))
      );
      const succeeded = createTarget('succeeded', 0);

      await createWorker([failed, succeeded]).runCycle();

      expect(failed.warm).toHaveBeenCalledTimes(1);
      expect(succeeded.warm).toHaveBeenCalledTimes(1);
      const metrics = getCacheWarmMetrics();
      expect(metrics.cache_warm_failures_total.samples).toEqual([
         { labels: { target: 'failed' }, value: 1 },
         { labels: { target: 'succeeded' }, value: 0 },
      ]);
      expect(metrics.cache_warm_duration_seconds.samples).toHaveLength(2);
      expect(mockLogger.error).toHaveBeenCalledWith(
         expect.objectContaining({ target: 'failed' }),
         'Cache warmer target failed'
      );
   });

   it('never runs more than two target computations concurrently', async () => {
      let release!: () => void;
      const gate = new Promise<void>(resolve => {
         release = resolve;
      });
      let inFlight = 0;
      let maxInFlight = 0;
      const targets = Array.from({ length: 6 }, (_, index) =>
         createTarget(
            `target-${index}`,
            0,
            jest.fn(async () => {
               inFlight += 1;
               maxInFlight = Math.max(maxInFlight, inFlight);
               await gate;
               inFlight -= 1;
            })
         )
      );

      const cycle = createWorker(targets, { concurrency: 6 }).runCycle();
      await flushMicrotasks();
      expect(maxInFlight).toBe(2);

      release();
      await cycle;
      expect(maxInFlight).toBe(2);
   });

   it('applies injectable jitter between zero and the configured maximum', async () => {
      const delays: number[] = [];
      const targets = [createTarget('first', 0), createTarget('second', 0)];
      const random = jest.fn().mockReturnValueOnce(0).mockReturnValueOnce(1);

      await createWorker(targets, {
         maxJitterMs: 10_000,
         random,
         sleep: async milliseconds => {
            delays.push(milliseconds);
         },
      }).runCycle();

      expect(delays).toEqual([0, 10_000]);
   });

   it('skips an overlapping cycle while the current one is in flight', async () => {
      let release!: () => void;
      const gate = new Promise<void>(resolve => {
         release = resolve;
      });
      const target = createTarget(
         'slow',
         0,
         jest.fn(() => gate)
      );
      const worker = createWorker([target]);

      const firstCycle = worker.runCycle();
      await flushMicrotasks();
      await worker.runCycle();

      expect(target.warm).toHaveBeenCalledTimes(1);
      expect(mockLogger.warn).toHaveBeenCalledWith(
         'Cache warmer cycle skipped: previous cycle is still in flight'
      );

      release();
      await firstCycle;
   });

   it('runs immediately, repeats on its interval, and clears the interval on stop', async () => {
      jest.useFakeTimers();
      const target = createTarget('periodic', 0);
      const worker = createWorker([target]);

      worker.start();
      await flushMicrotasks();
      expect(target.warm).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(CACHE_WARM_INTERVAL_MS);
      await flushMicrotasks();
      expect(target.warm).toHaveBeenCalledTimes(2);

      worker.stop();
      jest.advanceTimersByTime(CACHE_WARM_INTERVAL_MS);
      await flushMicrotasks();
      expect(target.warm).toHaveBeenCalledTimes(2);
   });
});
