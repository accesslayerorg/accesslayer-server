import { requestIdMiddleware } from './request-id.middleware';
import type { Request, Response, NextFunction } from 'express';

jest.mock('../config', () => ({
   envConfig: {
      TRACE_ID_TRUSTED_TOKEN: 'internal-secret-token',
   },
}));

function mockReq(headers: Record<string, string> = {}): Request {
   return { headers } as unknown as Request;
}

function mockRes(): Response & { headers: Record<string, string> } {
   const headers: Record<string, string> = {};
   return {
      headers,
      setHeader(name: string, value: string) {
         headers[name] = value;
      },
   } as unknown as Response & { headers: Record<string, string> };
}

describe('requestIdMiddleware', () => {
   it('generates a UUID v4 trace ID when no headers are present', () => {
      const req = mockReq();
      const res = mockRes();
      const next: NextFunction = jest.fn();

      requestIdMiddleware(req, res, next);

      expect(req.traceId).toMatch(
         /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
      expect(req.requestId).toBe(req.traceId);
      expect(res.headers['X-Trace-Id']).toBe(req.traceId);
      expect(res.headers['X-Request-ID']).toBe(req.traceId);
      expect(next).toHaveBeenCalled();
   });

   it('honors an incoming X-Request-ID header (legacy client correlation)', () => {
      const req = mockReq({ 'x-request-id': 'client-supplied-id' });
      const res = mockRes();

      requestIdMiddleware(req, res, jest.fn());

      expect(req.requestId).toBe('client-supplied-id');
      expect(req.traceId).toBe('client-supplied-id');
      expect(res.headers['X-Trace-Id']).toBe('client-supplied-id');
   });

   it('ignores an incoming X-Trace-Id header from an untrusted caller and generates a new one', () => {
      const req = mockReq({ 'x-trace-id': 'spoofed-trace-id' });
      const res = mockRes();

      requestIdMiddleware(req, res, jest.fn());

      expect(req.traceId).not.toBe('spoofed-trace-id');
      expect(req.traceId).toMatch(
         /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
   });

   it('reuses an incoming X-Trace-Id header when the caller presents the trusted internal service token', () => {
      const req = mockReq({
         'x-trace-id': 'upstream-service-trace-id',
         'x-internal-service-token': 'internal-secret-token',
      });
      const res = mockRes();

      requestIdMiddleware(req, res, jest.fn());

      expect(req.traceId).toBe('upstream-service-trace-id');
      expect(req.requestId).toBe('upstream-service-trace-id');
      expect(res.headers['X-Trace-Id']).toBe('upstream-service-trace-id');
   });

   it('does not reuse X-Trace-Id when the presented internal service token is wrong', () => {
      const req = mockReq({
         'x-trace-id': 'upstream-service-trace-id',
         'x-internal-service-token': 'wrong-token',
      });
      const res = mockRes();

      requestIdMiddleware(req, res, jest.fn());

      expect(req.traceId).not.toBe('upstream-service-trace-id');
   });

   it('generates independent trace IDs across concurrent requests', () => {
      const req1 = mockReq();
      const req2 = mockReq();

      requestIdMiddleware(req1, mockRes(), jest.fn());
      requestIdMiddleware(req2, mockRes(), jest.fn());

      expect(req1.traceId).not.toBe(req2.traceId);
   });
});
