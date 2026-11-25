import {
   moveToDLQ,
   getDLQDepth,
   getDLQQueueSummary,
   syncDLQMetrics,
   syncDLQQueueMetrics,
} from '../indexer-dlq.utils';
import { prisma } from '../prisma.utils';
import { setQueueDepth } from '../queue-metrics.utils';

jest.mock('../prisma.utils', () => ({
   prisma: {
      indexerDLQ: {
         create: jest.fn(),
         count: jest.fn(),
         groupBy: jest.fn(),
      },
   },
}));

jest.mock('../queue-metrics.utils', () => ({
   setQueueDepth: jest.fn(),
}));

describe('indexer-dlq.utils', () => {
   describe('moveToDLQ', () => {
      it('should call prisma.indexerDLQ.create with correct data', async () => {
         const params = {
            jobType: 'TEST_JOB',
            payload: { foo: 'bar' },
            retryCount: 3,
            failureReason: 'Test failure',
            errorDetails: 'Stack trace',
         };

         (prisma.indexerDLQ.create as jest.Mock).mockResolvedValue({
            id: '1',
            ...params,
         });

         await moveToDLQ(params);

         expect(prisma.indexerDLQ.create).toHaveBeenCalledWith({
            data: params,
         });
      });
   });

   describe('getDLQDepth', () => {
      it('counts only live (not yet replayed) entries when jobType is not provided', async () => {
         (prisma.indexerDLQ.count as jest.Mock).mockResolvedValue(5);

         const depth = await getDLQDepth();

         expect(depth).toBe(5);
         expect(prisma.indexerDLQ.count).toHaveBeenCalledWith({
            where: { replayedAt: null },
         });
      });

      it('counts live entries for one jobType when jobType is provided', async () => {
         (prisma.indexerDLQ.count as jest.Mock).mockResolvedValue(2);

         const depth = await getDLQDepth('TEST_JOB');

         expect(depth).toBe(2);
         expect(prisma.indexerDLQ.count).toHaveBeenCalledWith({
            where: { replayedAt: null, jobType: 'TEST_JOB' },
         });
      });
   });

   describe('getDLQQueueSummary', () => {
      it('reports depth and oldest age per job type', async () => {
         const now = new Date('2026-11-24T12:00:00.000Z');
         (prisma.indexerDLQ.groupBy as jest.Mock).mockResolvedValue([
            {
               jobType: 'KEY_DEPTH',
               _count: { _all: 3 },
               _min: { createdAt: new Date('2026-11-24T11:00:00.000Z') },
            },
         ]);

         const summary = await getDLQQueueSummary(now);

         expect(summary).toEqual([
            { queue: 'KEY_DEPTH', depth: 3, oldestAgeSeconds: 3600 },
         ]);
      });
   });

   describe('syncDLQQueueMetrics', () => {
      it('publishes depth and age for each job type queue', async () => {
         const now = new Date('2026-11-24T12:00:00.000Z');
         (prisma.indexerDLQ.groupBy as jest.Mock).mockResolvedValue([
            {
               jobType: 'outbox:order_filled',
               _count: { _all: 1 },
               _min: { createdAt: new Date('2026-11-24T11:59:30.000Z') },
            },
         ]);

         await syncDLQQueueMetrics(now);

         expect(setQueueDepth).toHaveBeenCalledWith(
            'outbox:order_filled',
            'dlq',
            1,
            30
         );
      });
   });

   describe('syncDLQMetrics', () => {
      it('should call getDLQDepth and then setQueueDepth', async () => {
         (prisma.indexerDLQ.count as jest.Mock).mockResolvedValue(10);

         await syncDLQMetrics();

         expect(prisma.indexerDLQ.count).toHaveBeenCalled();
         expect(setQueueDepth).toHaveBeenCalledWith('indexer', 'dlq', 10);
      });
   });
});
