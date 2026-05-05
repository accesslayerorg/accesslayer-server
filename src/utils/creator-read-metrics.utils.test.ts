import {
   createCreatorReadMetricsMiddleware,
   getCreatorReadMetrics,
   recordCreatorReadMetric,
   resetCreatorReadMetrics,
} from './creator-read-metrics.utils';

describe('creator-read-metrics.utils', () => {
   beforeEach(() => {
      resetCreatorReadMetrics();
   });

   it('tracks counters and histogram buckets for creator reads', () => {
      recordCreatorReadMetric('list', 7, 200);
      recordCreatorReadMetric('detail', 120, 503);

      const metrics = getCreatorReadMetrics();

      expect(metrics.counters.totalRequests).toBe(2);
      expect(metrics.counters.totalSuccess).toBe(1);
      expect(metrics.counters.totalServerErrors).toBe(1);
      expect(metrics.counters.byEndpoint.list.requests).toBe(1);
      expect(metrics.counters.byEndpoint.detail.serverErrors).toBe(1);
      expect(metrics.counters.byEndpoint.list.histogram.buckets[0].count).toBe(0);
      expect(metrics.counters.byEndpoint.list.histogram.buckets[1].count).toBe(1);
      const lastBucketIndex =
         metrics.counters.byEndpoint.detail.histogram.buckets.length - 1;
      expect(metrics.counters.byEndpoint.detail.histogram.buckets[lastBucketIndex].count).toBe(1);
   });

   it('records timing when the response finishes', () => {
      const clock = jest
         .fn()
         .mockReturnValueOnce(BigInt(1_000_000))
         .mockReturnValueOnce(BigInt(16_000_000));

      const middleware = createCreatorReadMetricsMiddleware('list', clock);
      const finishHandlers: Array<() => void> = [];
      const res = {
         statusCode: 200,
         on: jest.fn((event: string, handler: () => void) => {
            if (event === 'finish') {
               finishHandlers.push(handler);
            }

            return res;
         }),
      } as any;

      middleware({} as any, res, jest.fn());
      finishHandlers[0]();

      const metrics = getCreatorReadMetrics();

      expect(metrics.counters.byEndpoint.list.requests).toBe(1);
      expect(metrics.counters.byEndpoint.list.success).toBe(1);
      expect(metrics.counters.byEndpoint.list.histogram.count).toBe(1);
      expect(metrics.counters.byEndpoint.list.histogram.sumMs).toBeGreaterThan(0);
   });
});