// src/modules/health/health.controllers.test.ts

// Mock config and prisma before any imports that depend on them
jest.mock('../../config', () => ({
   envConfig: {
      MODE: 'test',
      INDEXER_HEARTBEAT_STALE_THRESHOLD_MS: 300_000,
   },
}));

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      $queryRaw: jest.fn(),
   },
}));

import { Request, Response } from 'express';
import {
   indexerHeartbeatCheck,
   recordIndexerHeartbeat,
} from './health.controllers';
import { indexerHeartbeat } from '../../utils/heartbeat.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockResponse(): Response {
   const res = {} as Response;
   res.status = jest.fn().mockReturnValue(res);
   res.json = jest.fn().mockReturnValue(res);
   return res;
}

function mockRequest(): Request {
   return {} as Request;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('indexerHeartbeatCheck', () => {
   beforeEach(() => {
      indexerHeartbeat.reset();
   });

   it('returns 200 with "unknown" status when no heartbeat recorded', () => {
      const req = mockRequest();
      const res = mockResponse();

      indexerHeartbeatCheck(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
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

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
         expect.objectContaining({
            success: true,
            data: expect.objectContaining({
               status: 'healthy',
            }),
         })
      );
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

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
         expect.objectContaining({
            success: true,
            data: expect.objectContaining({
               status: 'degraded',
            }),
         })
      );
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

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
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
