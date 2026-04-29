import { moveToDLQ, getDLQDepth, syncDLQMetrics } from '../indexer-dlq.utils';
import { prisma } from '../prisma.utils';
import { setQueueDepth } from '../queue-metrics.utils';

jest.mock('../prisma.utils', () => ({
  prisma: {
    indexerDLQ: {
      create: jest.fn(),
      count: jest.fn(),
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

      (prisma.indexerDLQ.create as jest.Mock).mockResolvedValue({ id: '1', ...params });

      await moveToDLQ(params);

      expect(prisma.indexerDLQ.create).toHaveBeenCalledWith({
        data: params,
      });
    });
  });

  describe('getDLQDepth', () => {
    it('should call prisma.indexerDLQ.count without where if jobType is not provided', async () => {
      (prisma.indexerDLQ.count as jest.Mock).mockResolvedValue(5);

      const depth = await getDLQDepth();

      expect(depth).toBe(5);
      expect(prisma.indexerDLQ.count).toHaveBeenCalledWith({
        where: undefined,
      });
    });

    it('should call prisma.indexerDLQ.count with where if jobType is provided', async () => {
      (prisma.indexerDLQ.count as jest.Mock).mockResolvedValue(2);

      const depth = await getDLQDepth('TEST_JOB');

      expect(depth).toBe(2);
      expect(prisma.indexerDLQ.count).toHaveBeenCalledWith({
        where: { jobType: 'TEST_JOB' },
      });
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
