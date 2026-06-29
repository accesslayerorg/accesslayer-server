import { logIndexerRetryExhaustion } from './indexer-retry-exhaustion.utils';
import { logger } from './logger.utils';

jest.mock('./logger.utils', () => ({
   logger: { error: jest.fn() },
   HTTP_STATUS: {},
}));

describe('logIndexerRetryExhaustion()', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('logs an error with required context fields', () => {
      logIndexerRetryExhaustion({ jobId: 'job-1', jobType: 'sync', retryCount: 5 });
      expect(logger.error).toHaveBeenCalledWith(
         expect.objectContaining({
            msg: 'Indexer job retry limit exhausted',
            jobId: 'job-1',
            jobType: 'sync',
            retryCount: 5,
         }),
      );
   });

   it('includes lastError when provided', () => {
      logIndexerRetryExhaustion({
         jobId: 'job-2',
         jobType: 'ingest',
         retryCount: 3,
         lastError: 'Connection timeout',
      });
      expect(logger.error).toHaveBeenCalledWith(
         expect.objectContaining({ lastError: 'Connection timeout' }),
      );
   });

   it('omits lastError when not provided', () => {
      logIndexerRetryExhaustion({ jobId: 'job-3', jobType: 'ingest', retryCount: 3 });
      const call = (logger.error as jest.Mock).mock.calls[0][0];
      expect(call).not.toHaveProperty('lastError');
   });

   it('sanitises control characters in lastError', () => {
      logIndexerRetryExhaustion({
         jobId: 'job-4',
         jobType: 'sync',
         retryCount: 1,
         lastError: 'Error\nwith\nnewlines',
      });
      const call = (logger.error as jest.Mock).mock.calls[0][0];
      expect(call.lastError).toBe('Error\\nwith\\nnewlines');
   });

   it('sanitises control characters in jobId and jobType', () => {
      logIndexerRetryExhaustion({
         jobId: 'job\ttab',
         jobType: 'sync\rnewline',
         retryCount: 1,
      });
      const call = (logger.error as jest.Mock).mock.calls[0][0];
      expect(call.jobId).toBe('job\\ttab');
      expect(call.jobType).toBe('sync\\rnewline');
   });

   it('includes sanitised payload when provided', () => {
      logIndexerRetryExhaustion({
         jobId: 'job-5',
         jobType: 'sync',
         retryCount: 2,
         payload: { key: 'value\n' },
      });
      const call = (logger.error as jest.Mock).mock.calls[0][0];
      expect(call.payload).toEqual({ key: 'value\\n' });
   });

   it('omits payload when not provided', () => {
      logIndexerRetryExhaustion({ jobId: 'job-6', jobType: 'sync', retryCount: 1 });
      const call = (logger.error as jest.Mock).mock.calls[0][0];
      expect(call).not.toHaveProperty('payload');
   });
});
