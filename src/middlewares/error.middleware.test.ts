import { errorHandler } from './error.middleware';
import { logger } from '../utils/logger.utils';
import { RpcTimeoutError } from '../utils/rpc-timeout.utils';

type MockResponse = {
   status: jest.Mock;
   json: jest.Mock;
};

jest.mock('../utils/logger.utils', () => ({
   logger: {
      warn: jest.fn(),
   },
}));

describe('Error Middleware', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('should warn with structured creator list timeout context and keep the response unchanged', () => {
      const req: any = {
         method: 'GET',
         originalUrl: '/api/v1/creators?limit=10&offset=0',
         query: {
            limit: '10',
            offset: '0',
         },
         requestId: 'request-123',
         hostname: 'localhost',
         protocol: 'http',
      };

      const res: MockResponse = {
         status: jest.fn().mockReturnThis(),
         json: jest.fn().mockReturnThis(),
      };

      const timeoutError = new RpcTimeoutError('creatorListQuery', 5000);

      errorHandler(timeoutError, req, res as any, jest.fn());

      expect(logger.warn).toHaveBeenCalledWith(
         expect.objectContaining({
            msg: 'Creator list request timed out',
            requestId: 'request-123',
            route: 'GET /api/v1/creators?limit=10&offset=0',
            queryParams: {
               limit: '10',
               offset: '0',
            },
            elapsedMs: 5000,
            timeoutMs: 5000,
         })
      );
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
         expect.objectContaining({
            success: false,
            code: expect.any(String),
            message: expect.any(String),
            requestId: 'request-123',
         })
      );
   });
});
