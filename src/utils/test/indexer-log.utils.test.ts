import { logRetryExhaustion } from '../indexer-log.utils';
import { logger } from '../logger.utils';

jest.mock('../logger.utils', () => ({
  logger: {
    warn: jest.fn(),
  },
}));

describe('indexer-log.utils', () => {
  describe('logRetryExhaustion', () => {
    it('should log retry exhaustion with sanitized payload', () => {
      const jobId = 'TEST_JOB';
      const context = { workerId: 'worker-1', retryCount: 3 };
      const payload = { foo: 'bar', password: 'secret', largeArray: Array(20).fill('item') };
      const failureReason = 'Test failure';
      const errorDetails = 'Stack trace';

      logRetryExhaustion(jobId, context, payload, failureReason, errorDetails);

      expect(logger.warn).toHaveBeenCalledWith({
        msg: 'Indexer job retry exhaustion',
        jobId,
        context,
        payload: {
          foo: 'bar',
          password: '[REDACTED]',
          largeArray: Array(10).fill('item').concat('...truncated'),
        },
        failureReason,
        errorDetails,
      });
    });

    it('should handle string payload truncation', () => {
      const jobId = 'TEST_JOB';
      const context = {};
      const payload = 'a'.repeat(600);
      const failureReason = 'Test failure';

      logRetryExhaustion(jobId, context, payload, failureReason);

      expect(logger.warn).toHaveBeenCalledWith({
        msg: 'Indexer job retry exhaustion',
        jobId,
        context,
        payload: 'a'.repeat(500) + '...',
        failureReason,
        errorDetails: undefined,
      });
    });

    it('should handle null payload', () => {
      const jobId = 'TEST_JOB';
      const context = {};
      const payload = null;
      const failureReason = 'Test failure';

      logRetryExhaustion(jobId, context, payload, failureReason);

      expect(logger.warn).toHaveBeenCalledWith({
        msg: 'Indexer job retry exhaustion',
        jobId,
        context,
        payload: null,
        failureReason,
        errorDetails: undefined,
      });
    });
  });
});