import { RequestHandler } from 'express';

export type CreatorReadEndpoint = 'list' | 'detail';

const DURATION_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000] as const;

export interface CreatorReadHistogramBucket {
   leMs: number | null;
   count: number;
}

export interface CreatorReadEndpointSnapshot {
   requests: number;
   success: number;
   clientErrors: number;
   serverErrors: number;
   histogram: {
      count: number;
      sumMs: number;
      buckets: CreatorReadHistogramBucket[];
   };
}

export interface CreatorReadMetricsSnapshot {
   counters: {
      totalRequests: number;
      totalSuccess: number;
      totalClientErrors: number;
      totalServerErrors: number;
      byEndpoint: Record<CreatorReadEndpoint, CreatorReadEndpointSnapshot>;
   };
}

type EndpointState = {
   requests: number;
   success: number;
   clientErrors: number;
   serverErrors: number;
   histogram: {
      count: number;
      sumMs: number;
      buckets: CreatorReadHistogramBucket[];
   };
};

const createHistogramBuckets = (): CreatorReadHistogramBucket[] =>
   [...DURATION_BUCKETS_MS, null].map(leMs => ({
      leMs,
      count: 0,
   }));

const createEndpointState = (): EndpointState => ({
   requests: 0,
   success: 0,
   clientErrors: 0,
   serverErrors: 0,
   histogram: {
      count: 0,
      sumMs: 0,
      buckets: createHistogramBuckets(),
   },
});

const registry: Record<CreatorReadEndpoint, EndpointState> = {
   list: createEndpointState(),
   detail: createEndpointState(),
};

function classifyStatus(statusCode: number): 'success' | 'clientErrors' | 'serverErrors' {
   if (statusCode >= 500) {
      return 'serverErrors';
   }

   if (statusCode >= 400) {
      return 'clientErrors';
   }

   return 'success';
}

function getHistogramBucketIndex(durationMs: number): number {
   const bucketIndex = DURATION_BUCKETS_MS.findIndex(limit => durationMs <= limit);
   return bucketIndex === -1 ? DURATION_BUCKETS_MS.length : bucketIndex;
}

export function recordCreatorReadMetric(
   endpoint: CreatorReadEndpoint,
   durationMs: number,
   statusCode: number
): void {
   const entry = registry[endpoint];
   const statusGroup = classifyStatus(statusCode);

   entry.requests += 1;
   entry[statusGroup] += 1;
   entry.histogram.count += 1;
   entry.histogram.sumMs += durationMs;

   const bucketIndex = getHistogramBucketIndex(durationMs);
   for (let index = bucketIndex; index < entry.histogram.buckets.length; index += 1) {
      entry.histogram.buckets[index].count += 1;
   }
}

export function createCreatorReadMetricsMiddleware(
   endpoint: CreatorReadEndpoint,
   now: () => bigint = () => process.hrtime.bigint()
): RequestHandler {
   return (_req, res, next) => {
      const startedAt = now();

      res.on('finish', () => {
         const durationMs = Number(now() - startedAt) / 1e6;
         recordCreatorReadMetric(endpoint, durationMs, res.statusCode);
      });

      next();
   };
}

function snapshotEndpoint(entry: EndpointState): CreatorReadEndpointSnapshot {
   return {
      requests: entry.requests,
      success: entry.success,
      clientErrors: entry.clientErrors,
      serverErrors: entry.serverErrors,
      histogram: {
         count: entry.histogram.count,
         sumMs: entry.histogram.sumMs,
         buckets: entry.histogram.buckets.map(bucket => ({ ...bucket })),
      },
   };
}

export function getCreatorReadMetrics(): CreatorReadMetricsSnapshot {
   return {
      counters: {
         totalRequests: registry.list.requests + registry.detail.requests,
         totalSuccess: registry.list.success + registry.detail.success,
         totalClientErrors: registry.list.clientErrors + registry.detail.clientErrors,
         totalServerErrors: registry.list.serverErrors + registry.detail.serverErrors,
         byEndpoint: {
            list: snapshotEndpoint(registry.list),
            detail: snapshotEndpoint(registry.detail),
         },
      },
   };
}

export function resetCreatorReadMetrics(): void {
   registry.list = createEndpointState();
   registry.detail = createEndpointState();
}