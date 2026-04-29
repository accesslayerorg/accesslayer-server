// src/modules/health/health.controllers.test.ts
import { Request, Response } from 'express';

// Mock config and prisma before any imports that depend on them
jest.mock('../../config', () => ({
   envConfig: {
      MODE: 'test',
      PORT: 3000,
      INDEXER_HEARTBEAT_STALE_THRESHOLD_MS: 300000,
   },
   appConfig: {
      allowedOrigins: [],
   },
}));

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      $queryRaw: jest.fn(),
   },
}));

import {
   indexerHeartbeatCheck,
   recordIndexerHeartbeat,
   readinessCheck,
} from './health.controllers';
import { indexerHeartbeat } from '../../utils/heartbeat.service';
import { prisma } from '../../utils/prisma.utils';

const queryRawMock = prisma.$queryRaw as unknown as jest.Mock;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockResponse(): Response & { statusCode: number; body: any } {
   const res = {
      statusCode: 0,
      body: undefined as any,
   } as any;

   res.status = (code: number) => {
      res.statusCode = code;
      return res;
   };

   res.json = (payload: any) => {
      res.body = payload;
      return res;
   };

   return res;
}

function mockRequest(): Request {
   return {} as Request;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Indexer Heartbeat Controllers', () => {
   describe('indexerHeartbeatCheck', () => {
      beforeEach(() => {
         indexerHeartbeat.reset();
      });

      it('returns 200 with "unknown" status when no heartbeat recorded', () => {
         const req = mockRequest();
         const res = mockResponse();

         indexerHeartbeatCheck(req, res);

         expect(res.statusCode).toBe(200);
         expect(res.body).toEqual(
            expect.objectContaining({
               success: true,
               data: expect.objectContaining({
                  service: 'indexer',
                  status: 'unknown',
                  lastSuccessfulRun: null,
                  staleSinceMs: null,
               }),
            })
         );
      });

      it('returns 200 with "healthy" status after a fresh heartbeat', () => {
         indexerHeartbeat.recordHeartbeat();
         const req = mockRequest();
         const res = mockResponse();

         indexerHeartbeatCheck(req, res);

         expect(res.statusCode).toBe(200);
         expect(res.body.data.status).toBe('healthy');
      });

      it('returns 503 with "degraded" status when heartbeat is stale', () => {
         // Record a heartbeat, then backdate it
         indexerHeartbeat.recordHeartbeat();
         const longAgo = new Date(Date.now() - 10 * 60 * 1000); // 10 min ago
         (
            indexerHeartbeat as unknown as { lastSuccessfulRun: Date }
         ).lastSuccessfulRun = longAgo;

         const req = mockRequest();
         const res = mockResponse();

         indexerHeartbeatCheck(req, res);

         expect(res.statusCode).toBe(503);
         expect(res.body.data.status).toBe('degraded');
      });
   });

   describe('recordIndexerHeartbeat', () => {
      beforeEach(() => {
         indexerHeartbeat.reset();
      });

      it('records a heartbeat and returns 200', () => {
         const req = mockRequest();
         const res = mockResponse();

         recordIndexerHeartbeat(req, res);

         expect(res.statusCode).toBe(200);
         expect(res.body).toEqual(
            expect.objectContaining({
               success: true,
               data: expect.objectContaining({
                  recorded: true,
                  timestamp: expect.any(String),
               }),
               message: 'Heartbeat recorded',
            })
         );
      });

      it('makes the indexer status healthy', () => {
         const req = mockRequest();
         const res = mockResponse();

         recordIndexerHeartbeat(req, res);

         expect(indexerHeartbeat.getStatus().status).toBe('healthy');
      });
   });
});

describe('Readiness Controller', () => {
   describe('readinessCheck()', () => {
      beforeEach(() => {
         queryRawMock.mockReset();
      });

      it('includes a top-level latencyMs field in the response metadata', async () => {
         queryRawMock.mockResolvedValue([{ '?column?': 1 }]);
         const res = mockResponse();

         await readinessCheck({} as Request, res);

         expect(res.statusCode).toBe(200);
         expect(res.body.ready).toBe(true);
         expect(typeof res.body.latencyMs).toBe('number');
         expect(res.body.latencyMs).toBeGreaterThanOrEqual(0);
      });

      it('still reports latencyMs when a check fails (returns 503)', async () => {
         queryRawMock.mockRejectedValue(new Error('connection refused'));
         const res = mockResponse();

         await readinessCheck({} as Request, res);

         expect(res.statusCode).toBe(503);
         expect(res.body.ready).toBe(false);
         expect(typeof res.body.latencyMs).toBe('number');
      });

      it('keeps the existing per-check latencyMs alongside the new top-level field', async () => {
         queryRawMock.mockResolvedValue([{ '?column?': 1 }]);
         const res = mockResponse();

         await readinessCheck({} as Request, res);

         const dbCheck = res.body.checks.find((c: any) => c.name === 'database');
         expect(dbCheck.status).toBe('ok');
         expect(typeof dbCheck.latencyMs).toBe('number');
         expect(typeof res.body.latencyMs).toBe('number');
      });
   });
});
