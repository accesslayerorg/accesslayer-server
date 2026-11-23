jest.mock('../../utils/queue-metrics.utils', () => ({
   getQueueDepths: jest.fn(() => [
      { queue: 'ingest', state: 'pending', depth: 3 },
   ]),
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

jest.mock('../../utils/order-keeper-metrics.utils', () => ({
   getOrderKeeperMetrics: jest.fn(() => ({
      keeper_fills_total: {
         type: 'counter',
         samples: [{ labels: {}, value: 3 }],
      },
      keeper_skipped_total: {
         type: 'counter',
         samples: [{ labels: {}, value: 2 }],
      },
   })),
}));

import {
   creatorReadMetrics,
   orderKeeperMetrics,
   queueMetrics,
} from './metrics.controllers';

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

   it('returns order keeper counters', () => {
      const res = {
         status: jest.fn().mockReturnThis(),
         type: jest.fn().mockReturnThis(),
         send: jest.fn(),
      } as any;

      orderKeeperMetrics({} as any, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.type).toHaveBeenCalledWith(
         'text/plain; version=0.0.4; charset=utf-8'
      );
      expect(res.send).toHaveBeenCalledWith(
         expect.stringContaining('keeper_fills_total 3')
      );
      expect(res.send).toHaveBeenCalledWith(
         expect.stringContaining('keeper_skipped_total 2')
      );
   });
});
