// Unit tests for #681 — structured logs for outbound Horizon API calls.

import { horizonRequest, normalizeHorizonEndpoint } from './horizon-api.utils';
import { logger } from './logger.utils';
import { RpcTimeoutError, withRpcTimeout } from './rpc-timeout.utils';

jest.mock('./logger.utils', () => ({
   logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
   },
}));

jest.mock('./rpc-timeout.utils', () => {
   const actual = jest.requireActual('./rpc-timeout.utils');
   return {
      ...actual,
      withRpcTimeout: jest.fn(
         (_operation: string, fn: () => Promise<unknown>) => fn()
      ),
   };
});

const mockLogger = logger as unknown as {
   info: jest.Mock;
   warn: jest.Mock;
};

const mockWithRpcTimeout = withRpcTimeout as jest.MockedFunction<
   typeof withRpcTimeout
>;

describe('#681 Horizon API structured logging', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      mockWithRpcTimeout.mockImplementation((_op, fn) => fn());
   });

   describe('normalizeHorizonEndpoint', () => {
      it('keeps path-only endpoints', () => {
         expect(normalizeHorizonEndpoint('/ledgers?order=desc')).toBe(
            '/ledgers?order=desc'
         );
      });

      it('strips the origin from absolute URLs', () => {
         expect(
            normalizeHorizonEndpoint(
               'https://horizon-testnet.stellar.org/accounts/GABC'
            )
         ).toBe('/accounts/GABC');
      });
   });

   it('emits info log with all five fields after a completed Horizon call', async () => {
      const mockResponse = { status: 200 } as Response;
      global.fetch = jest.fn().mockResolvedValue(mockResponse);

      await horizonRequest('/ledgers?order=desc&limit=1', {
         method: 'GET',
         headers: { Authorization: 'Bearer secret-token' },
      });

      expect(mockLogger.info).toHaveBeenCalledTimes(1);
      const [fields] = mockLogger.info.mock.calls[0];
      expect(fields).toMatchObject({
         horizon_endpoint: '/ledgers?order=desc&limit=1',
         method: 'GET',
         status_code: 200,
      });
      expect(fields.response_time_ms).toEqual(expect.any(Number));
      expect(fields.response_time_ms).toBeGreaterThanOrEqual(0);
      expect(fields.called_at).toEqual(expect.any(String));
      expect(() => new Date(fields.called_at).toISOString()).not.toThrow();
      expect(JSON.stringify(fields)).not.toContain('secret-token');
      expect(JSON.stringify(fields)).not.toContain('Authorization');
   });

   it('does not include request body in log fields', async () => {
      global.fetch = jest.fn().mockResolvedValue({ status: 201 } as Response);

      await horizonRequest('/transactions', {
         method: 'POST',
         body: '{"sensitive":"payload"}',
      });

      const [fields] = mockLogger.info.mock.calls[0];
      expect(JSON.stringify(fields)).not.toContain('sensitive');
      expect(JSON.stringify(fields)).not.toContain('payload');
   });

   it('emits warn log with timed_out and no status_code on timeout', async () => {
      mockWithRpcTimeout.mockImplementation(() =>
         Promise.reject(new RpcTimeoutError('horizon:GET:/ledgers', 50))
      );

      await expect(horizonRequest('/ledgers')).rejects.toBeInstanceOf(
         RpcTimeoutError
      );

      expect(mockLogger.warn).toHaveBeenCalledTimes(1);
      expect(mockLogger.info).not.toHaveBeenCalled();
      const [fields] = mockLogger.warn.mock.calls[0];
      expect(fields).toMatchObject({
         horizon_endpoint: '/ledgers',
         method: 'GET',
         timed_out: true,
      });
      expect(fields).not.toHaveProperty('status_code');
      expect(fields.response_time_ms).toBeGreaterThanOrEqual(0);
      expect(fields.called_at).toEqual(expect.any(String));
   });

   it('does not emit timeout warn log for non-timeout failures', async () => {
      mockWithRpcTimeout.mockImplementation(() =>
         Promise.reject(new Error('network down'))
      );

      await expect(horizonRequest('/accounts/GABC')).rejects.toThrow(
         'network down'
      );

      expect(mockLogger.warn).not.toHaveBeenCalled();
      expect(mockLogger.info).not.toHaveBeenCalled();
   });
});
