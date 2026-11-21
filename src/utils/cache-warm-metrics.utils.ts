const DURATION_BUCKETS_SECONDS = [
   0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5,
] as const;

interface TargetMetricState {
   durationCount: number;
   durationSumSeconds: number;
   durationBuckets: number[];
   failures: number;
}

const registry = new Map<string, TargetMetricState>();

function getTargetState(target: string): TargetMetricState {
   let state = registry.get(target);
   if (!state) {
      state = {
         durationCount: 0,
         durationSumSeconds: 0,
         durationBuckets: DURATION_BUCKETS_SECONDS.map(() => 0),
         failures: 0,
      };
      registry.set(target, state);
   }
   return state;
}

export function recordCacheWarmDuration(
   target: string,
   durationSeconds: number
): void {
   const state = getTargetState(target);
   state.durationCount += 1;
   state.durationSumSeconds += durationSeconds;

   const bucketIndex = DURATION_BUCKETS_SECONDS.findIndex(
      limit => durationSeconds <= limit
   );
   for (
      let index =
         bucketIndex === -1 ? state.durationBuckets.length : bucketIndex;
      index < state.durationBuckets.length;
      index += 1
   ) {
      state.durationBuckets[index] += 1;
   }
}

export function recordCacheWarmFailure(target: string): void {
   getTargetState(target).failures += 1;
}

export interface CacheWarmMetricsSnapshot {
   cache_warm_duration_seconds: {
      type: 'histogram';
      samples: Array<{
         labels: { target: string };
         count: number;
         sum: number;
         buckets: Array<{ le: number | null; count: number }>;
      }>;
   };
   cache_warm_failures_total: {
      type: 'counter';
      samples: Array<{ labels: { target: string }; value: number }>;
   };
}

export function getCacheWarmMetrics(): CacheWarmMetricsSnapshot {
   const targets = [...registry.entries()].sort(([left], [right]) =>
      left.localeCompare(right)
   );
   return {
      cache_warm_duration_seconds: {
         type: 'histogram',
         samples: targets.map(([target, state]) => ({
            labels: { target },
            count: state.durationCount,
            sum: state.durationSumSeconds,
            buckets: [
               ...DURATION_BUCKETS_SECONDS.map((le, index) => ({
                  le,
                  count: state.durationBuckets[index],
               })),
               { le: null, count: state.durationCount },
            ],
         })),
      },
      cache_warm_failures_total: {
         type: 'counter',
         samples: targets.map(([target, state]) => ({
            labels: { target },
            value: state.failures,
         })),
      },
   };
}

export function resetCacheWarmMetrics(): void {
   registry.clear();
}
