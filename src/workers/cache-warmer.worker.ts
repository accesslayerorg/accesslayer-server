import {
   CACHE_WARM_CONCURRENCY,
   CACHE_WARM_INTERVAL_MS,
   CACHE_WARM_MAX_JITTER_MS,
   CACHE_WARM_SKIP_THRESHOLD,
   WARM_TARGETS,
} from '../config/cache-warm';
import type { CacheWarmTarget } from '../config/cache-warm';
import { logger } from '../utils/logger.utils';
import {
   recordCacheWarmDuration,
   recordCacheWarmFailure,
} from '../utils/cache-warm-metrics.utils';

export interface CacheWarmerWorkerOptions {
   targets?: readonly CacheWarmTarget[];
   intervalMs?: number;
   concurrency?: number;
   maxJitterMs?: number;
   skipThreshold?: number;
   random?: () => number;
   sleep?: (milliseconds: number) => Promise<void>;
}

const sleepFor = (milliseconds: number): Promise<void> =>
   new Promise(resolve => setTimeout(resolve, milliseconds));

export class CacheWarmerWorker {
   private readonly targets: readonly CacheWarmTarget[];
   private readonly intervalMs: number;
   private readonly concurrency: number;
   private readonly maxJitterMs: number;
   private readonly skipThreshold: number;
   private readonly random: () => number;
   private readonly sleep: (milliseconds: number) => Promise<void>;
   private timer: ReturnType<typeof setInterval> | null = null;
   private cycleInFlight = false;

   constructor(options: CacheWarmerWorkerOptions = {}) {
      this.targets = options.targets ?? WARM_TARGETS;
      this.intervalMs = options.intervalMs ?? CACHE_WARM_INTERVAL_MS;
      this.concurrency = Math.min(
         CACHE_WARM_CONCURRENCY,
         Math.max(1, Math.floor(options.concurrency ?? CACHE_WARM_CONCURRENCY))
      );
      this.maxJitterMs = Math.min(
         CACHE_WARM_MAX_JITTER_MS,
         Math.max(0, options.maxJitterMs ?? CACHE_WARM_MAX_JITTER_MS)
      );
      this.skipThreshold = options.skipThreshold ?? CACHE_WARM_SKIP_THRESHOLD;
      this.random = options.random ?? Math.random;
      this.sleep = options.sleep ?? sleepFor;
   }

   start(): void {
      if (this.timer) {
         logger.warn('Cache warmer worker is already running');
         return;
      }

      void this.runCycle().catch(error => {
         logger.error({ error }, 'Cache warmer cycle failed unexpectedly');
      });
      this.timer = setInterval(() => {
         void this.runCycle().catch(error => {
            logger.error({ error }, 'Cache warmer cycle failed unexpectedly');
         });
      }, this.intervalMs);

      if (
         typeof (this.timer as unknown as { unref?: () => void }).unref ===
         'function'
      ) {
         (this.timer as unknown as { unref: () => void }).unref();
      }

      logger.info(
         { intervalMs: this.intervalMs },
         'Cache warmer worker started'
      );
   }

   stop(): void {
      if (!this.timer) return;
      clearInterval(this.timer);
      this.timer = null;
      logger.info('Cache warmer worker stopped');
   }

   async runCycle(): Promise<void> {
      if (this.cycleInFlight) {
         logger.warn(
            'Cache warmer cycle skipped: previous cycle is still in flight'
         );
         return;
      }

      this.cycleInFlight = true;
      try {
         let nextTargetIndex = 0;
         const runNextTarget = async (): Promise<void> => {
            while (nextTargetIndex < this.targets.length) {
               const target = this.targets[nextTargetIndex];
               nextTargetIndex += 1;
               await this.runTarget(target);
            }
         };

         await Promise.all(
            Array.from(
               { length: Math.min(this.concurrency, this.targets.length) },
               () => runNextTarget()
            )
         );
      } finally {
         this.cycleInFlight = false;
      }
   }

   private async runTarget(target: CacheWarmTarget): Promise<void> {
      try {
         const randomValue = Math.min(1, Math.max(0, this.random()));
         await this.sleep(Math.floor(randomValue * this.maxJitterMs));
      } catch (error) {
         recordCacheWarmFailure(target.name);
         logger.error(
            { error, target: target.name },
            'Cache warmer target failed before warming'
         );
         return;
      }

      let remainingTtlMs: number | null = null;
      try {
         remainingTtlMs = await target.getRemainingTtlMs();
      } catch (error) {
         logger.warn(
            { error, target: target.name, cacheKey: target.cacheKey() },
            'Cache warmer could not read remaining TTL; warming target'
         );
      }
      if (
         remainingTtlMs !== null &&
         remainingTtlMs > target.ttlMs * this.skipThreshold
      ) {
         return;
      }

      const startedAt = Date.now();
      try {
         await target.warm();
      } catch (error) {
         recordCacheWarmFailure(target.name);
         logger.error(
            { error, target: target.name },
            'Cache warmer target failed'
         );
      } finally {
         recordCacheWarmDuration(
            target.name,
            Math.max(0, Date.now() - startedAt) / 1000
         );
      }
   }
}

let cacheWarmerWorker: CacheWarmerWorker | null = null;

export function startCacheWarmerWorker(): void {
   if (cacheWarmerWorker) {
      logger.warn('Cache warmer worker is already running');
      return;
   }
   cacheWarmerWorker = new CacheWarmerWorker();
   cacheWarmerWorker.start();
}

export function stopCacheWarmerWorker(): void {
   cacheWarmerWorker?.stop();
   cacheWarmerWorker = null;
}
