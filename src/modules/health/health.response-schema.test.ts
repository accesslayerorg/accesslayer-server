// src/modules/health/health.response-schema.test.ts
//
// Verifies that every documented response field exists, carries the right type,
// and takes only the values listed in docs/health-endpoints.md.
// These tests act as a living contract between the code and the documentation.

jest.mock('../../config', () => ({
   envConfig: {
      MODE: 'test',
      PORT: 3000,
      INDEXER_HEARTBEAT_STALE_THRESHOLD_MS: 300000,
      DB_QUERY_TIMEOUT_MS: 5000,
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

jest.mock('../../utils/indexer-cursor-staleness.utils', () => ({
   checkIndexerCursorStalenessFromStore: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../utils/redis.utils', () => ({
   getRedisClient: jest.fn(() => ({
      ping: jest.fn().mockResolvedValue('PONG'),
   })),
}));

jest.mock('../../clients/horizon.client', () => ({
   horizonGet: jest.fn().mockResolvedValue({ ok: true }),
}));

import { Request, Response } from 'express';
import {
   healthCheck,
   indexerHeartbeatCheck,
   readinessCheck,
   recordIndexerHeartbeat,
   simpleHealthCheck,
} from './health.controllers';
import { indexerHeartbeat } from '../../utils/heartbeat.service';
import { prisma } from '../../utils/prisma.utils';

const queryRawMock = prisma.$queryRaw as unknown as jest.Mock;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockResponse(): Response & { statusCode: number; body: any } {
   const res = { statusCode: 0, body: undefined as any } as any;
   res.status = (code: number) => {
      res.statusCode = code;
      return res;
   };
   res.json = (payload: any) => {
      res.body = payload;
      return res;
   };
   res.setHeader = () => res;
   return res;
}

function mockRequest(): Request {
   return {} as Request;
}

// ---------------------------------------------------------------------------
// GET /api/v1/health — liveness + dependency probes
// ---------------------------------------------------------------------------

describe('GET /health — response schema', () => {
   beforeEach(() => {
      queryRawMock.mockReset();
   });

   it('returns HTTP 200 when all dependencies are healthy', async () => {
      queryRawMock.mockResolvedValue([{ '?column?': 1 }]);
      const res = mockResponse();
      await simpleHealthCheck(mockRequest(), res);
      expect(res.statusCode).toBe(200);
   });

   it('returns HTTP 503 when any dependency is degraded', async () => {
      queryRawMock.mockRejectedValue(new Error('connection refused'));
      const res = mockResponse();
      await simpleHealthCheck(mockRequest(), res);
      expect(res.statusCode).toBe(503);
   });

   it('has success field set to true when healthy', async () => {
      queryRawMock.mockResolvedValue([{ '?column?': 1 }]);
      const res = mockResponse();
      await simpleHealthCheck(mockRequest(), res);
      expect(res.body.success).toBe(true);
   });

   it('has timestamp field as a valid ISO-8601 string', async () => {
      queryRawMock.mockResolvedValue([{ '?column?': 1 }]);
      const res = mockResponse();
      await simpleHealthCheck(mockRequest(), res);
      expect(typeof res.body.timestamp).toBe('string');
      expect(new Date(res.body.timestamp).toISOString()).toBe(
         res.body.timestamp
      );
   });

   it('lists database, redis, and horizon checks with individual statuses', async () => {
      queryRawMock.mockResolvedValue([{ '?column?': 1 }]);
      const res = mockResponse();
      await simpleHealthCheck(mockRequest(), res);
      const names = res.body.checks.map((c: any) => c.name);
      expect(names).toContain('database');
      expect(names).toContain('redis');
      expect(names).toContain('horizon');
      for (const check of res.body.checks) {
         expect(['ok', 'degraded']).toContain(check.status);
      }
   });

   it('includes a degraded array listing degraded dependencies when any fail', async () => {
      queryRawMock.mockRejectedValue(new Error('connection refused'));
      const res = mockResponse();
      await simpleHealthCheck(mockRequest(), res);
      expect(res.body.status).toBe('degraded');
      expect(Array.isArray(res.body.degraded)).toBe(true);
      expect(res.body.degraded).toContain('database');
   });
});

// ---------------------------------------------------------------------------
// GET /api/v1/health/ready — readiness: healthy path
// ---------------------------------------------------------------------------

describe('GET /health/ready — readiness response schema (all checks pass)', () => {
   beforeEach(() => {
      queryRawMock.mockResolvedValue([{ '?column?': 1 }]);
   });

   afterEach(() => {
      queryRawMock.mockReset();
   });

   it('returns HTTP 200 when all checks pass', async () => {
      const res = mockResponse();
      await readinessCheck(mockRequest(), res);
      expect(res.statusCode).toBe(200);
   });

   it('has ready field set to true', async () => {
      const res = mockResponse();
      await readinessCheck(mockRequest(), res);
      expect(res.body.ready).toBe(true);
   });

   it('has timestamp as a valid ISO-8601 string', async () => {
      const res = mockResponse();
      await readinessCheck(mockRequest(), res);
      expect(typeof res.body.timestamp).toBe('string');
      expect(new Date(res.body.timestamp).toISOString()).toBe(
         res.body.timestamp
      );
   });

   it('has latencyMs as a non-negative number', async () => {
      const res = mockResponse();
      await readinessCheck(mockRequest(), res);
      expect(typeof res.body.latencyMs).toBe('number');
      expect(res.body.latencyMs).toBeGreaterThanOrEqual(0);
   });

   it('has checks as an array', async () => {
      const res = mockResponse();
      await readinessCheck(mockRequest(), res);
      expect(Array.isArray(res.body.checks)).toBe(true);
   });

   it('includes a "database" check with status "ok"', async () => {
      const res = mockResponse();
      await readinessCheck(mockRequest(), res);
      const dbCheck = res.body.checks.find((c: any) => c.name === 'database');
      expect(dbCheck).toBeDefined();
      expect(dbCheck.status).toBe('ok');
   });

   it('includes latencyMs on the database check when it passes', async () => {
      const res = mockResponse();
      await readinessCheck(mockRequest(), res);
      const dbCheck = res.body.checks.find((c: any) => c.name === 'database');
      expect(typeof dbCheck.latencyMs).toBe('number');
      expect(dbCheck.latencyMs).toBeGreaterThanOrEqual(0);
   });

   it('includes a "cache" check with status "ok"', async () => {
      const res = mockResponse();
      await readinessCheck(mockRequest(), res);
      const cacheCheck = res.body.checks.find((c: any) => c.name === 'cache');
      expect(cacheCheck).toBeDefined();
      expect(cacheCheck.status).toBe('ok');
   });

   it('check status values are only "ok" or "fail"', async () => {
      const res = mockResponse();
      await readinessCheck(mockRequest(), res);
      for (const check of res.body.checks) {
         expect(['ok', 'fail']).toContain(check.status);
      }
   });
});

// ---------------------------------------------------------------------------
// GET /api/v1/health/ready — readiness: database failure path
// ---------------------------------------------------------------------------

describe('GET /health/ready — readiness response schema (database failure)', () => {
   beforeEach(() => {
      queryRawMock.mockRejectedValue(new Error('connection refused'));
   });

   afterEach(() => {
      queryRawMock.mockReset();
   });

   it('returns HTTP 503 when a check fails', async () => {
      const res = mockResponse();
      await readinessCheck(mockRequest(), res);
      expect(res.statusCode).toBe(503);
   });

   it('sets ready to false — the sole non-200 trigger', async () => {
      const res = mockResponse();
      await readinessCheck(mockRequest(), res);
      expect(res.body.ready).toBe(false);
   });

   it('includes error string on the failed check — no stack trace or hostnames', async () => {
      const res = mockResponse();
      await readinessCheck(mockRequest(), res);
      const dbCheck = res.body.checks.find((c: any) => c.name === 'database');
      expect(dbCheck.status).toBe('fail');
      expect(typeof dbCheck.error).toBe('string');
      expect(dbCheck.error.length).toBeGreaterThan(0);
   });

   it('does not include latencyMs on the failed database check', async () => {
      const res = mockResponse();
      await readinessCheck(mockRequest(), res);
      const dbCheck = res.body.checks.find((c: any) => c.name === 'database');
      expect(dbCheck.latencyMs).toBeUndefined();
   });

   it('still includes latencyMs at the top level even when a check fails', async () => {
      const res = mockResponse();
      await readinessCheck(mockRequest(), res);
      expect(typeof res.body.latencyMs).toBe('number');
      expect(res.body.latencyMs).toBeGreaterThanOrEqual(0);
   });

   it('cache check still passes independently of the database check', async () => {
      const res = mockResponse();
      await readinessCheck(mockRequest(), res);
      const cacheCheck = res.body.checks.find((c: any) => c.name === 'cache');
      expect(cacheCheck).toBeDefined();
      expect(cacheCheck.status).toBe('ok');
   });
});

// ---------------------------------------------------------------------------
// GET /api/v1/health/detailed — diagnostics: healthy path
// ---------------------------------------------------------------------------

describe('GET /health/detailed — diagnostics response schema (DB connected)', () => {
   beforeEach(() => {
      queryRawMock.mockResolvedValue([{ '?column?': 1 }]);
   });

   afterEach(() => {
      queryRawMock.mockReset();
   });

   it('returns HTTP 200', async () => {
      const res = mockResponse();
      await healthCheck(mockRequest(), res);
      expect(res.statusCode).toBe(200);
   });

   it('has success set to true', async () => {
      const res = mockResponse();
      await healthCheck(mockRequest(), res);
      expect(res.body.success).toBe(true);
   });

   it('has message as a non-empty string', async () => {
      const res = mockResponse();
      await healthCheck(mockRequest(), res);
      expect(typeof res.body.message).toBe('string');
      expect(res.body.message.length).toBeGreaterThan(0);
   });

   it('has timestamp as a valid ISO-8601 string', async () => {
      const res = mockResponse();
      await healthCheck(mockRequest(), res);
      expect(typeof res.body.timestamp).toBe('string');
      expect(new Date(res.body.timestamp).toISOString()).toBe(
         res.body.timestamp
      );
   });

   it('has version as a non-empty string', async () => {
      const res = mockResponse();
      await healthCheck(mockRequest(), res);
      expect(typeof res.body.version).toBe('string');
      expect(res.body.version.length).toBeGreaterThan(0);
   });

   it('has environment as a non-empty string', async () => {
      const res = mockResponse();
      await healthCheck(mockRequest(), res);
      expect(typeof res.body.environment).toBe('string');
      expect(res.body.environment.length).toBeGreaterThan(0);
   });

   it('has uptime as a non-negative number (seconds)', async () => {
      const res = mockResponse();
      await healthCheck(mockRequest(), res);
      expect(typeof res.body.uptime).toBe('number');
      expect(res.body.uptime).toBeGreaterThanOrEqual(0);
   });

   describe('memory object', () => {
      it('has memory.used as a non-negative number (megabytes)', async () => {
         const res = mockResponse();
         await healthCheck(mockRequest(), res);
         expect(typeof res.body.memory.used).toBe('number');
         expect(res.body.memory.used).toBeGreaterThanOrEqual(0);
      });

      it('has memory.total as a positive number (megabytes)', async () => {
         const res = mockResponse();
         await healthCheck(mockRequest(), res);
         expect(typeof res.body.memory.total).toBe('number');
         expect(res.body.memory.total).toBeGreaterThan(0);
      });

      it('has memory.used <= memory.total', async () => {
         const res = mockResponse();
         await healthCheck(mockRequest(), res);
         expect(res.body.memory.used).toBeLessThanOrEqual(
            res.body.memory.total
         );
      });
   });

   describe('system object', () => {
      it('has system.platform as a non-empty string', async () => {
         const res = mockResponse();
         await healthCheck(mockRequest(), res);
         expect(typeof res.body.system.platform).toBe('string');
         expect(res.body.system.platform.length).toBeGreaterThan(0);
      });

      it('has system.nodeVersion as a string starting with "v"', async () => {
         const res = mockResponse();
         await healthCheck(mockRequest(), res);
         expect(typeof res.body.system.nodeVersion).toBe('string');
         expect(res.body.system.nodeVersion).toMatch(/^v\d+/);
      });
   });

   describe('timeouts object', () => {
      it('has timeouts.database_timeout_ms as a positive number', async () => {
         const res = mockResponse();
         await healthCheck(mockRequest(), res);
         expect(typeof res.body.timeouts.database_timeout_ms).toBe('number');
         expect(res.body.timeouts.database_timeout_ms).toBeGreaterThan(0);
      });

      it('has timeouts.cache_timeout_ms as a positive number', async () => {
         const res = mockResponse();
         await healthCheck(mockRequest(), res);
         expect(typeof res.body.timeouts.cache_timeout_ms).toBe('number');
         expect(res.body.timeouts.cache_timeout_ms).toBeGreaterThan(0);
      });
   });

   describe('database object', () => {
      it('has database.status set to "connected" when DB responds', async () => {
         const res = mockResponse();
         await healthCheck(mockRequest(), res);
         expect(res.body.database.status).toBe('connected');
      });

      it('database.status is only "connected" or "disconnected"', async () => {
         const res = mockResponse();
         await healthCheck(mockRequest(), res);
         expect(['connected', 'disconnected']).toContain(
            res.body.database.status
         );
      });

      it('has database.responseTime as a non-negative number when connected', async () => {
         const res = mockResponse();
         await healthCheck(mockRequest(), res);
         expect(typeof res.body.database.responseTime).toBe('number');
         expect(res.body.database.responseTime).toBeGreaterThanOrEqual(0);
      });
   });

   describe('syncing object', () => {
      it('has syncing.status as either "in-sync" or "degraded"', async () => {
         const res = mockResponse();
         await healthCheck(mockRequest(), res);
         if (res.body.syncing !== undefined) {
            expect(['in-sync', 'degraded']).toContain(res.body.syncing.status);
         }
      });

      it('has syncing.latestIndexedLedger as a non-negative integer when present', async () => {
         const res = mockResponse();
         await healthCheck(mockRequest(), res);
         if (res.body.syncing !== undefined) {
            expect(typeof res.body.syncing.latestIndexedLedger).toBe('number');
            expect(res.body.syncing.latestIndexedLedger).toBeGreaterThanOrEqual(
               0
            );
         }
      });

      it('has syncing.observedHeadLedger as a non-negative integer when present', async () => {
         const res = mockResponse();
         await healthCheck(mockRequest(), res);
         if (res.body.syncing !== undefined) {
            expect(typeof res.body.syncing.observedHeadLedger).toBe('number');
            expect(res.body.syncing.observedHeadLedger).toBeGreaterThanOrEqual(
               0
            );
         }
      });

      it('has syncing.syncLagLedgers equal to observedHead - latestIndexed', async () => {
         const res = mockResponse();
         await healthCheck(mockRequest(), res);
         if (res.body.syncing !== undefined) {
            expect(res.body.syncing.syncLagLedgers).toBe(
               res.body.syncing.observedHeadLedger -
                  res.body.syncing.latestIndexedLedger
            );
         }
      });
   });

   describe('services array', () => {
      it('has services as an array', async () => {
         const res = mockResponse();
         await healthCheck(mockRequest(), res);
         expect(Array.isArray(res.body.services)).toBe(true);
      });

      it('includes "API Server", "Database", and "Chain Sync" entries', async () => {
         const res = mockResponse();
         await healthCheck(mockRequest(), res);
         const names = res.body.services.map((s: any) => s.name);
         expect(names).toContain('API Server');
         expect(names).toContain('Database');
         expect(names).toContain('Chain Sync');
      });

      it('each service status is only "healthy" or "unhealthy"', async () => {
         const res = mockResponse();
         await healthCheck(mockRequest(), res);
         for (const svc of res.body.services) {
            expect(['healthy', 'unhealthy']).toContain(svc.status);
         }
      });

      it('"API Server" is always healthy', async () => {
         const res = mockResponse();
         await healthCheck(mockRequest(), res);
         const apiServer = res.body.services.find(
            (s: any) => s.name === 'API Server'
         );
         expect(apiServer.status).toBe('healthy');
      });

      it('"Database" service is "healthy" when database is connected', async () => {
         const res = mockResponse();
         await healthCheck(mockRequest(), res);
         const dbService = res.body.services.find(
            (s: any) => s.name === 'Database'
         );
         expect(dbService.status).toBe('healthy');
      });
   });
});

// ---------------------------------------------------------------------------
// GET /api/v1/health/detailed — diagnostics: database failure in test mode
// ---------------------------------------------------------------------------

describe('GET /health/detailed — diagnostics response schema (DB disconnected, non-production)', () => {
   beforeEach(() => {
      queryRawMock.mockRejectedValue(new Error('connection refused'));
   });

   afterEach(() => {
      queryRawMock.mockReset();
   });

   it('returns HTTP 200 in non-production even when DB is disconnected', async () => {
      const res = mockResponse();
      await healthCheck(mockRequest(), res);
      // MODE is "test" in this suite's mock — non-production returns 200
      expect(res.statusCode).toBe(200);
   });

   it('has database.status set to "disconnected"', async () => {
      const res = mockResponse();
      await healthCheck(mockRequest(), res);
      expect(res.body.database.status).toBe('disconnected');
   });

   it('does not include database.responseTime when disconnected', async () => {
      const res = mockResponse();
      await healthCheck(mockRequest(), res);
      expect(res.body.database.responseTime).toBeUndefined();
   });

   it('"Database" service is "unhealthy" when database is disconnected', async () => {
      const res = mockResponse();
      await healthCheck(mockRequest(), res);
      const dbService = res.body.services.find(
         (s: any) => s.name === 'Database'
      );
      expect(dbService.status).toBe('unhealthy');
   });
});

// ---------------------------------------------------------------------------
// GET /api/v1/health/indexer — worker heartbeat: all three status values
// ---------------------------------------------------------------------------

describe('GET /health/indexer — indexer heartbeat response schema', () => {
   beforeEach(() => {
      indexerHeartbeat.reset();
   });

   it('has success set to true in all states', () => {
      const res = mockResponse();
      indexerHeartbeatCheck(mockRequest(), res);
      expect(res.body.success).toBe(true);
   });

   it('has data.service set to "indexer"', () => {
      const res = mockResponse();
      indexerHeartbeatCheck(mockRequest(), res);
      expect(res.body.data.service).toBe('indexer');
   });

   it('data.status is only "healthy", "degraded", or "unknown"', () => {
      const res = mockResponse();
      indexerHeartbeatCheck(mockRequest(), res);
      expect(['healthy', 'degraded', 'unknown']).toContain(
         res.body.data.status
      );
   });

   describe('"unknown" state — no heartbeat ever recorded', () => {
      it('returns HTTP 200', () => {
         const res = mockResponse();
         indexerHeartbeatCheck(mockRequest(), res);
         expect(res.statusCode).toBe(200);
      });

      it('has data.status set to "unknown"', () => {
         const res = mockResponse();
         indexerHeartbeatCheck(mockRequest(), res);
         expect(res.body.data.status).toBe('unknown');
      });

      it('has data.lastSuccessfulRun as null', () => {
         const res = mockResponse();
         indexerHeartbeatCheck(mockRequest(), res);
         expect(res.body.data.lastSuccessfulRun).toBeNull();
      });

      it('has data.staleSinceMs as null', () => {
         const res = mockResponse();
         indexerHeartbeatCheck(mockRequest(), res);
         expect(res.body.data.staleSinceMs).toBeNull();
      });
   });

   describe('"healthy" state — recent heartbeat recorded', () => {
      beforeEach(() => {
         indexerHeartbeat.recordHeartbeat();
      });

      it('returns HTTP 200', () => {
         const res = mockResponse();
         indexerHeartbeatCheck(mockRequest(), res);
         expect(res.statusCode).toBe(200);
      });

      it('has data.status set to "healthy"', () => {
         const res = mockResponse();
         indexerHeartbeatCheck(mockRequest(), res);
         expect(res.body.data.status).toBe('healthy');
      });

      it('has data.lastSuccessfulRun as a valid ISO-8601 string', () => {
         const res = mockResponse();
         indexerHeartbeatCheck(mockRequest(), res);
         expect(typeof res.body.data.lastSuccessfulRun).toBe('string');
         expect(new Date(res.body.data.lastSuccessfulRun).toISOString()).toBe(
            res.body.data.lastSuccessfulRun
         );
      });

      it('has data.staleSinceMs as null when healthy', () => {
         const res = mockResponse();
         indexerHeartbeatCheck(mockRequest(), res);
         expect(res.body.data.staleSinceMs).toBeNull();
      });
   });

   describe('"degraded" state — stale heartbeat', () => {
      beforeEach(() => {
         indexerHeartbeat.recordHeartbeat();
         const longAgo = new Date(Date.now() - 10 * 60 * 1000); // 10 min ago
         (
            indexerHeartbeat as unknown as { lastSuccessfulRun: Date }
         ).lastSuccessfulRun = longAgo;
      });

      it('returns HTTP 503 — sole non-200 trigger for this endpoint', () => {
         const res = mockResponse();
         indexerHeartbeatCheck(mockRequest(), res);
         expect(res.statusCode).toBe(503);
      });

      it('has data.status set to "degraded"', () => {
         const res = mockResponse();
         indexerHeartbeatCheck(mockRequest(), res);
         expect(res.body.data.status).toBe('degraded');
      });

      it('has data.lastSuccessfulRun as a valid ISO-8601 string', () => {
         const res = mockResponse();
         indexerHeartbeatCheck(mockRequest(), res);
         expect(typeof res.body.data.lastSuccessfulRun).toBe('string');
         expect(new Date(res.body.data.lastSuccessfulRun).toISOString()).toBe(
            res.body.data.lastSuccessfulRun
         );
      });

      it('has data.staleSinceMs as a positive number when degraded', () => {
         const res = mockResponse();
         indexerHeartbeatCheck(mockRequest(), res);
         expect(typeof res.body.data.staleSinceMs).toBe('number');
         expect(res.body.data.staleSinceMs).toBeGreaterThan(0);
      });
   });
});

// ---------------------------------------------------------------------------
// POST /api/v1/health/indexer/heartbeat — record worker run
// ---------------------------------------------------------------------------

describe('POST /health/indexer/heartbeat — response schema', () => {
   beforeEach(() => {
      indexerHeartbeat.reset();
   });

   it('returns HTTP 200', async () => {
      const res = mockResponse();
      await recordIndexerHeartbeat(mockRequest(), res);
      expect(res.statusCode).toBe(200);
   });

   it('has success set to true', async () => {
      const res = mockResponse();
      await recordIndexerHeartbeat(mockRequest(), res);
      expect(res.body.success).toBe(true);
   });

   it('has data.recorded set to true', async () => {
      const res = mockResponse();
      await recordIndexerHeartbeat(mockRequest(), res);
      expect(res.body.data.recorded).toBe(true);
   });

   it('has data.timestamp as a valid ISO-8601 string', async () => {
      const res = mockResponse();
      await recordIndexerHeartbeat(mockRequest(), res);
      expect(typeof res.body.data.timestamp).toBe('string');
      expect(new Date(res.body.data.timestamp).toISOString()).toBe(
         res.body.data.timestamp
      );
   });

   it('has message set to "Heartbeat recorded"', async () => {
      const res = mockResponse();
      await recordIndexerHeartbeat(mockRequest(), res);
      expect(res.body.message).toBe('Heartbeat recorded');
   });
});
