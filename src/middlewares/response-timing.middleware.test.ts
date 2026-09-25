import EventEmitter from 'events';
import express from 'express';
import request from 'supertest';
import {
   responseTimingMiddleware,
   createResponseTimingMiddleware,
   resolveAuthenticatedWallet,
} from './response-timing.middleware';
import { logger } from '../utils/logger.utils';
import * as monotonicClock from '../utils/monotonic-clock.utils';
import { envConfig } from '../config';

jest.mock('../utils/logger.utils', () => ({
   logger: {
      warn: jest.fn(),
      info: jest.fn(),
      error: jest.fn(),
   },
}));

class MockResponse extends EventEmitter {
   statusCode = 200;
   headers: Record<string, string> = {};
   writeHead = jest.fn((statusCode: number, headers?: any) => {
      this.statusCode = statusCode;
      if (headers) Object.assign(this.headers, headers);
      return this;
   });
   setHeader = jest.fn((name: string, value: string) => {
      this.headers[name.toLowerCase()] = value;
      return this;
   });
   end = jest.fn(() => {
      this.emit('finish');
      return this;
   });
}

function makeReq(overrides: Record<string, unknown> = {}): any {
   return {
      method: 'GET',
      path: '/api/v1/creators',
      originalUrl: '/api/v1/creators?page=1',
      headers: {},
      ...overrides,
   };
}

describe('responseTimingMiddleware & Slow Request Logging (#754)', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      jest.restoreAllMocks();
   });

   describe('resolveAuthenticatedWallet', () => {
      it('resolves wallet from req.user.wallet', () => {
         const req = makeReq({ user: { wallet: 'GAUTHUSER123' } });
         expect(resolveAuthenticatedWallet(req)).toBe('GAUTHUSER123');
      });

      it('resolves wallet from req.walletAddress', () => {
         const req = makeReq({ walletAddress: 'GSTELLARSIGN456' });
         expect(resolveAuthenticatedWallet(req)).toBe('GSTELLARSIGN456');
      });

      it('resolves wallet from req.wallet', () => {
         const req = makeReq({ wallet: 'GWALLETDIRECT789' });
         expect(resolveAuthenticatedWallet(req)).toBe('GWALLETDIRECT789');
      });

      it('resolves wallet from x-wallet-address header', () => {
         const req = makeReq({
            headers: { 'x-wallet-address': 'GHEADERWALLET321' },
         });
         expect(resolveAuthenticatedWallet(req)).toBe('GHEADERWALLET321');
      });

      it('returns undefined when no authentication metadata is present', () => {
         const req = makeReq();
         expect(resolveAuthenticatedWallet(req)).toBeUndefined();
      });
   });

   describe('Slow request logging unit tests', () => {
      it('emits a warn log with all six fields when request exceeds threshold for an authenticated user', () => {
         jest.spyOn(monotonicClock, 'elapsedMs').mockReturnValue(2500);

         const middleware = createResponseTimingMiddleware({
            slowThresholdMs: 2000,
         });
         const req = makeReq({
            method: 'POST',
            path: '/api/v1/creators/710/sell',
            originalUrl: '/api/v1/creators/710/sell?ref=dashboard',
            user: { wallet: 'GAUTHWALLET999' },
            body: { quantity: 10, secret_pin: '1234' },
         });
         const res = new MockResponse();
         res.statusCode = 200;

         const next = jest.fn();
         middleware(req, res as any, next);

         expect(next).toHaveBeenCalledTimes(1);
         // Log must NOT be emitted before response is sent
         expect(logger.warn).not.toHaveBeenCalled();

         // Emit finish to simulate response completion
         res.emit('finish');

         expect(logger.warn).toHaveBeenCalledTimes(1);
         const [logPayload, message] = (logger.warn as jest.Mock).mock.calls[0];

         expect(message).toBe('Slow request detected');
         expect(logPayload).toEqual({
            method: 'POST',
            path: '/api/v1/creators/710/sell',
            status_code: 200,
            duration_ms: 2500,
            wallet: 'GAUTHWALLET999',
            slow_threshold_ms: 2000,
         });

         // Verify all six fields are present
         expect(logPayload).toHaveProperty('method');
         expect(logPayload).toHaveProperty('path');
         expect(logPayload).toHaveProperty('status_code');
         expect(logPayload).toHaveProperty('duration_ms');
         expect(logPayload).toHaveProperty('wallet');
         expect(logPayload).toHaveProperty('slow_threshold_ms');

         // Verify request body and response body are absent
         expect(logPayload).not.toHaveProperty('body');
         expect(logPayload).not.toHaveProperty('request_body');
         expect(logPayload).not.toHaveProperty('response_body');
         expect(logPayload).not.toHaveProperty('secret_pin');
      });

      it('omits wallet from the log when request is not authenticated', () => {
         jest.spyOn(monotonicClock, 'elapsedMs').mockReturnValue(2150);

         const middleware = createResponseTimingMiddleware({
            slowThresholdMs: 2000,
         });
         const req = makeReq({
            method: 'GET',
            path: '/api/v1/public-data',
            originalUrl: '/api/v1/public-data',
         });
         const res = new MockResponse();
         res.statusCode = 404;

         middleware(req, res as any, jest.fn());
         res.emit('finish');

         expect(logger.warn).toHaveBeenCalledTimes(1);
         const [logPayload] = (logger.warn as jest.Mock).mock.calls[0];

         expect(logPayload).toMatchObject({
            method: 'GET',
            path: '/api/v1/public-data',
            status_code: 404,
            duration_ms: 2150,
            slow_threshold_ms: 2000,
         });
         expect(logPayload.wallet).toBeUndefined();
         expect(logPayload).not.toHaveProperty('wallet');
      });

      it('does NOT emit a slow-request warn log for fast requests', () => {
         jest.spyOn(monotonicClock, 'elapsedMs').mockReturnValue(150);

         const middleware = createResponseTimingMiddleware({
            slowThresholdMs: 2000,
         });
         const req = makeReq();
         const res = new MockResponse();

         middleware(req, res as any, jest.fn());
         res.emit('finish');

         expect(logger.warn).not.toHaveBeenCalled();
      });

      it('does NOT emit a slow-request warn log when duration exactly equals the threshold', () => {
         jest.spyOn(monotonicClock, 'elapsedMs').mockReturnValue(2000);

         const middleware = createResponseTimingMiddleware({
            slowThresholdMs: 2000,
         });
         const req = makeReq();
         const res = new MockResponse();

         middleware(req, res as any, jest.fn());
         res.emit('finish');

         expect(logger.warn).not.toHaveBeenCalled();
      });

      it('responseTimingMiddleware uses configured SLOW_REQUEST_THRESHOLD_MS from envConfig by default', () => {
         const originalThreshold = envConfig.SLOW_REQUEST_THRESHOLD_MS;
         (envConfig as any).SLOW_REQUEST_THRESHOLD_MS = 500;

         try {
            jest.spyOn(monotonicClock, 'elapsedMs').mockReturnValue(600);

            const req = makeReq();
            const res = new MockResponse();

            responseTimingMiddleware(req, res as any, jest.fn());
            res.emit('finish');

            expect(logger.warn).toHaveBeenCalledTimes(1);
            const [logPayload] = (logger.warn as jest.Mock).mock.calls[0];
            expect(logPayload.slow_threshold_ms).toBe(500);
            expect(logPayload.duration_ms).toBe(600);
         } finally {
            (envConfig as any).SLOW_REQUEST_THRESHOLD_MS = originalThreshold;
         }
      });

      it('logs only once even if both finish and close events fire', () => {
         jest.spyOn(monotonicClock, 'elapsedMs').mockReturnValue(3000);

         const middleware = createResponseTimingMiddleware({
            slowThresholdMs: 2000,
         });
         const req = makeReq();
         const res = new MockResponse();

         middleware(req, res as any, jest.fn());
         res.emit('finish');
         res.emit('close');

         expect(logger.warn).toHaveBeenCalledTimes(1);
      });
   });

   describe('Express integration test', () => {
      it('integrates with Express and emits a warn log for slow endpoints after response is sent', async () => {
         jest.spyOn(monotonicClock, 'elapsedMs').mockReturnValue(2200);

         const app = express();
         app.use(createResponseTimingMiddleware({ slowThresholdMs: 1000 }));
         app.get('/test-slow', (req, res) => {
            (req as any).user = { wallet: 'GEXPRESSWALLET123' };
            res.status(200).json({ status: 'ok', sensitive_secret: 'hidden' });
         });

         const response = await request(app).get('/test-slow');

         expect(response.status).toBe(200);
         expect(response.body).toEqual({
            status: 'ok',
            sensitive_secret: 'hidden',
         });

         expect(logger.warn).toHaveBeenCalledTimes(1);
         const [logPayload] = (logger.warn as jest.Mock).mock.calls[0];

         expect(logPayload).toEqual({
            method: 'GET',
            path: '/test-slow',
            status_code: 200,
            duration_ms: 2200,
            wallet: 'GEXPRESSWALLET123',
            slow_threshold_ms: 1000,
         });
         expect(logPayload).not.toHaveProperty('body');
         expect(logPayload).not.toHaveProperty('response_body');
         expect(logPayload).not.toHaveProperty('sensitive_secret');
      });

      it('does not emit a warn log for fast endpoints in Express', async () => {
         jest.spyOn(monotonicClock, 'elapsedMs').mockReturnValue(45);

         const app = express();
         app.use(createResponseTimingMiddleware({ slowThresholdMs: 1000 }));
         app.get('/test-fast', (_req, res) => {
            res.status(200).json({ status: 'fast' });
         });

         const response = await request(app).get('/test-fast');

         expect(response.status).toBe(200);
         expect(logger.warn).not.toHaveBeenCalled();
      });
   });
});
