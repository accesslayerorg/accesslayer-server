// src/routes/federation.routes.test.ts

jest.mock('../services/federation.service', () => {
   const actual = jest.requireActual('../services/federation.service');
   return {
      ...actual,
      federationService: { resolve: jest.fn() },
   };
});

import express from 'express';
import request from 'supertest';
import federationRouter from './federation.routes';
import {
   FederationBlockedAddressError,
   FederationNotFoundError,
   FederationTimeoutError,
   FederationUpstreamError,
   federationService,
} from '../services/federation.service';

const resolveMock = federationService.resolve as unknown as jest.Mock;

const app = express();
app.use('/federation', federationRouter);

beforeEach(() => {
   resolveMock.mockReset();
   resolveMock.mockResolvedValue({ accountId: 'GABCDEF' });
});

describe('GET /federation/resolve', () => {
   it('returns the resolved federation record', async () => {
      resolveMock.mockResolvedValueOnce({
         accountId: 'GABCDEF',
         memo: '12345',
         memoType: 'id',
      });

      const res = await request(app)
         .get('/federation/resolve')
         .query({ address: 'alice*example.com' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
         accountId: 'GABCDEF',
         memo: '12345',
         memoType: 'id',
      });
      expect(resolveMock).toHaveBeenCalledWith('alice*example.com');
   });

   it('normalizes the address before resolving', async () => {
      const res = await request(app)
         .get('/federation/resolve')
         .query({ address: '  ALICE*Example.COM  ' });

      expect(res.status).toBe(200);
      expect(resolveMock).toHaveBeenCalledWith('alice*example.com');
   });

   it('returns 400 when the address is missing', async () => {
      const res = await request(app).get('/federation/resolve');

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(resolveMock).not.toHaveBeenCalled();
   });

   it.each(['alice', 'alice*localhost', 'ali*ce*example.com'])(
      'returns 400 for malformed address %s without calling the service',
      async address => {
         const res = await request(app)
            .get('/federation/resolve')
            .query({ address });

         expect(res.status).toBe(400);
         expect(res.body.success).toBe(false);
         expect(res.body.error.code).toBe('VALIDATION_ERROR');
         expect(resolveMock).not.toHaveBeenCalled();
      }
   );

   it('returns 400 when the domain resolves to a blocked address', async () => {
      resolveMock.mockRejectedValueOnce(
         new FederationBlockedAddressError(
            'Refusing to contact example.com: resolved address 10.0.0.5 is not public'
         )
      );

      const res = await request(app)
         .get('/federation/resolve')
         .query({ address: 'alice*example.com' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('BAD_REQUEST');
      expect(res.body.error.message).toContain('non-public address');
   });

   it('returns 404 when the address is not found', async () => {
      resolveMock.mockRejectedValueOnce(
         new FederationNotFoundError('alice*example.com')
      );

      const res = await request(app)
         .get('/federation/resolve')
         .query({ address: 'alice*example.com' });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('NOT_FOUND');
   });

   it('returns 504 when the lookup times out', async () => {
      resolveMock.mockRejectedValueOnce(new FederationTimeoutError(3000));

      const res = await request(app)
         .get('/federation/resolve')
         .query({ address: 'alice*example.com' });

      expect(res.status).toBe(504);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('GATEWAY_TIMEOUT');
      expect(res.body.error.message).toContain('timed out');
   });

   it('returns 502 when the federation server fails', async () => {
      resolveMock.mockRejectedValueOnce(
         new FederationUpstreamError('connection refused')
      );

      const res = await request(app)
         .get('/federation/resolve')
         .query({ address: 'alice*example.com' });

      expect(res.status).toBe(502);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('BAD_GATEWAY');
   });
});
