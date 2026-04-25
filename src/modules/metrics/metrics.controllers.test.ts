jest.mock('../../utils/queue-metrics.utils', () => ({
   getQueueDepths: jest.fn(() => [{ queue: 'ingest', state: 'pending', depth: 3 }]),
}));

jest.mock('../../utils/creator-read-metrics.utils', () => ({
   getCreatorReadMetrics: jest.fn(() => ({
      counters: {
         totalRequests: 2,
         totalSuccess: 1,
         totalClientErrors: 0,
         totalServerErrors: 1,
         byEndpoint: {
            list: {
               requests: 1,
               success: 1,
               clientErrors: 0,
               serverErrors: 0,
               histogram: {
                  count: 1,
                  sumMs: 12.5,
                  buckets: [{ leMs: 5, count: 0 }],
               },
            },
            detail: {
               requests: 1,
               success: 0,
               clientErrors: 0,
               serverErrors: 1,
               histogram: {
                  count: 1,
                  sumMs: 84.2,
                  buckets: [{ leMs: 5, count: 0 }],
               },
            },
         },
      },
   })),
}));

import { creatorReadMetrics, queueMetrics } from './metrics.controllers';

describe('metrics.controllers', () => {
   it('returns queue depth metrics', () => {
      const res = {
         status: jest.fn().mockReturnThis(),
         json: jest.fn(),
      } as any;

      queueMetrics({} as any, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
         expect.objectContaining({
            queues: [{ queue: 'ingest', state: 'pending', depth: 3 }],
         })
      );
   });

   it('returns creator read metrics', () => {
      const res = {
         status: jest.fn().mockReturnThis(),
         json: jest.fn(),
      } as any;

      creatorReadMetrics({} as any, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
         expect.objectContaining({
            creatorReads: expect.objectContaining({
               counters: expect.objectContaining({
                  totalRequests: 2,
                  byEndpoint: expect.objectContaining({
                     list: expect.objectContaining({ requests: 1 }),
                  }),
               }),
            }),
         })
      );
   });
});