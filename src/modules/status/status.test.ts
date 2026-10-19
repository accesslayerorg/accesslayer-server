// src/modules/status/status.test.ts
// Unit tests for platform status service, probes, uptime, and incident management (#1015).

import {
   probeDatabase,
   probeRedis,
   probeHorizon,
   probeSorobanRpc,
   probeIndexer,
   runAllProbes,
   getLatestStatus,
   get30DayUptimeHistory,
   createIncident,
   getIncidents,
   resetStatusStore,
   recordProbeForTesting,
} from './status.service';
import {
   setAdminWalletsForTesting,
   clearAdminWalletsForTesting,
   requireStatusAdminWallet,
   StatusAdminRequest,
} from './status.auth';
import { prisma } from '../../utils/prisma.utils';
import { getRedisClient } from '../../utils/redis.utils';
import { horizonGet } from '../../clients/horizon.client';
import { indexerHeartbeat } from '../../utils/heartbeat.service';
import { signWalletAccessToken } from '../../utils/jwt.utils';
import { Response } from 'express';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      $queryRaw: jest.fn(),
      platformStatusProbe: {
         createMany: jest.fn().mockResolvedValue({ count: 5 }),
         findMany: jest.fn().mockResolvedValue([]),
      },
      platformIncident: {
         create: jest.fn().mockImplementation((args: any) => Promise.resolve(args.data)),
         findMany: jest.fn().mockResolvedValue([]),
         count: jest.fn().mockResolvedValue(0),
      },
   },
}));

jest.mock('../../clients/horizon.client', () => ({
   horizonGet: jest.fn(),
}));

jest.mock('../../utils/redis.utils', () => ({
   getRedisClient: jest.fn(),
   getRedis: jest.fn(),
}));

describe('Platform Status Service', () => {
   beforeEach(() => {
      resetStatusStore();
      clearAdminWalletsForTesting();
      jest.clearAllMocks();
   });

   describe('Individual Health Probes', () => {
      it('probeDatabase returns operational when query succeeds', async () => {
         (prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([{ '?column?': 1 }]);
         const result = await probeDatabase();

         expect(result.name).toBe('database');
         expect(result.status).toBe('operational');
         expect(result.lastChecked).toBeDefined();
         expect(typeof result.latencyMs).toBe('number');
      });

      it('probeDatabase returns down and logs error when query rejects', async () => {
         (prisma.$queryRaw as jest.Mock).mockRejectedValueOnce(
            new Error('connection timeout')
         );
         const result = await probeDatabase();

         expect(result.name).toBe('database');
         expect(result.status).toBe('down');
         expect(result.error).toContain('connection timeout');
      });

      it('probeRedis returns operational when ping returns PONG', async () => {
         (getRedisClient as jest.Mock).mockReturnValue({
            ping: jest.fn().mockResolvedValue('PONG'),
         });
         const result = await probeRedis();

         expect(result.name).toBe('redis');
         expect(result.status).toBe('operational');
      });

      it('probeRedis returns down when ping throws error', async () => {
         (getRedisClient as jest.Mock).mockReturnValue({
            ping: jest.fn().mockRejectedValue(new Error('Redis connection refused')),
         });
         const result = await probeRedis();

         expect(result.name).toBe('redis');
         expect(result.status).toBe('down');
         expect(result.error).toContain('Redis connection refused');
      });

      it('probeHorizon returns operational when HTTP 200', async () => {
         (horizonGet as jest.Mock).mockResolvedValueOnce({
            ok: true,
            status: 200,
         });
         const result = await probeHorizon();

         expect(result.name).toBe('horizon');
         expect(result.status).toBe('operational');
      });

      it('probeHorizon returns down when network fails', async () => {
         (horizonGet as jest.Mock).mockRejectedValueOnce(new Error('DNS lookup failed'));
         const result = await probeHorizon();

         expect(result.name).toBe('horizon');
         expect(result.status).toBe('down');
      });

      it('probeSorobanRpc returns operational when healthy RPC response', async () => {
         const originalFetch = global.fetch;
         global.fetch = jest.fn().mockResolvedValueOnce({
            ok: true,
            json: async () => ({ jsonrpc: '2.0', id: 1, result: { status: 'healthy' } }),
         }) as unknown as typeof fetch;

         try {
            const result = await probeSorobanRpc();
            expect(result.name).toBe('soroban-rpc');
            expect(result.status).toBe('operational');
         } finally {
            global.fetch = originalFetch;
         }
      });

      it('probeIndexer returns operational when heartbeat is ok', () => {
         jest.spyOn(indexerHeartbeat, 'getStatus').mockReturnValueOnce({
            service: 'indexer',
            status: 'healthy',
            lastSuccessfulRun: new Date().toISOString(),
            staleSinceMs: null,
         });

         const result = probeIndexer();
         expect(result.name).toBe('indexer');
         expect(result.status).toBe('operational');
      });

      it('probeIndexer returns degraded when heartbeat is degraded', () => {
         jest.spyOn(indexerHeartbeat, 'getStatus').mockReturnValueOnce({
            service: 'indexer',
            status: 'degraded',
            lastSuccessfulRun: new Date(Date.now() - 400000).toISOString(),
            staleSinceMs: 100000,
         });

         const result = probeIndexer();
         expect(result.name).toBe('indexer');
         expect(result.status).toBe('degraded');
      });
   });

   describe('runAllProbes', () => {
      it('executes all 5 core dependency probes concurrently', async () => {
         (prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([1]);
         (getRedisClient as jest.Mock).mockReturnValue({
            ping: jest.fn().mockResolvedValue('PONG'),
         });
         (horizonGet as jest.Mock).mockResolvedValueOnce({ ok: true, status: 200 });

         const results = await runAllProbes();
         expect(results).toHaveLength(5);
         const names = results.map(r => r.name);
         expect(names).toEqual(
            expect.arrayContaining([
               'database',
               'redis',
               'horizon',
               'soroban-rpc',
               'indexer',
            ])
         );
      });
   });

   describe('getLatestStatus & response time (<500ms)', () => {
      it('responds in under 500ms from cached probe states', async () => {
         recordProbeForTesting('database', 'operational');
         recordProbeForTesting('redis', 'operational');
         recordProbeForTesting('horizon', 'operational');
         recordProbeForTesting('soroban-rpc', 'operational');
         recordProbeForTesting('indexer', 'operational');

         const start = Date.now();
         const status = await getLatestStatus();
         const duration = Date.now() - start;

         expect(duration).toBeLessThan(500);
         expect(status.success).toBe(true);
         expect(status.status).toBe('operational');
         expect(status.services).toHaveLength(5);
      });

      it('marks service as degraded when probe check is stale (>3 minutes)', async () => {
         const fourMinutesAgo = new Date(Date.now() - 4 * 60 * 1000);
         recordProbeForTesting('database', 'operational', fourMinutesAgo);
         recordProbeForTesting('redis', 'operational');
         recordProbeForTesting('horizon', 'operational');
         recordProbeForTesting('soroban-rpc', 'operational');
         recordProbeForTesting('indexer', 'operational');

         const status = await getLatestStatus();
         const db = status.services.find(s => s.name === 'database');
         expect(db?.status).toBe('degraded');
         expect(db?.message).toContain('Probe result is stale');
         expect(status.status).toBe('degraded');
      });

      it('reflects down status when any dependency is down', async () => {
         recordProbeForTesting('database', 'down');
         recordProbeForTesting('redis', 'operational');
         recordProbeForTesting('horizon', 'operational');
         recordProbeForTesting('soroban-rpc', 'operational');
         recordProbeForTesting('indexer', 'operational');

         const status = await getLatestStatus();
         expect(status.status).toBe('down');
      });
   });

   describe('30-Day Uptime Percentage Calculation', () => {
      it('returns 100% uptime when all checks are operational', async () => {
         for (let i = 0; i < 10; i++) {
            recordProbeForTesting('database', 'operational');
         }

         const history = await get30DayUptimeHistory(30);
         const dbUptime = history.services.find(s => s.name === 'database');
         expect(dbUptime?.uptimePercentage).toBe(100);
         expect(dbUptime?.totalChecks).toBe(10);
         expect(dbUptime?.successfulChecks).toBe(10);
      });

      it('computes fractional uptime correctly (e.g. 90% for 9/10 operational)', async () => {
         for (let i = 0; i < 9; i++) {
            recordProbeForTesting('redis', 'operational');
         }
         recordProbeForTesting('redis', 'down');

         const history = await get30DayUptimeHistory(30);
         const redisUptime = history.services.find(s => s.name === 'redis');
         expect(redisUptime?.uptimePercentage).toBe(90.0);
         expect(redisUptime?.totalChecks).toBe(10);
         expect(redisUptime?.successfulChecks).toBe(9);
      });

      it('defaults to 100% when no checks recorded in window', async () => {
         const history = await get30DayUptimeHistory(30);
         const horizonUptime = history.services.find(s => s.name === 'horizon');
         expect(horizonUptime?.uptimePercentage).toBe(100.0);
         expect(horizonUptime?.totalChecks).toBe(0);
      });

      it('excludes checks outside the 30-day window', async () => {
         const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
         recordProbeForTesting('horizon', 'down', fortyDaysAgo);
         recordProbeForTesting('horizon', 'operational', new Date());

         const history = await get30DayUptimeHistory(30);
         const horizonUptime = history.services.find(s => s.name === 'horizon');
         expect(horizonUptime?.uptimePercentage).toBe(100);
         expect(horizonUptime?.totalChecks).toBe(1);
      });
   });

   describe('Incidents (Creation & Pagination)', () => {
      it('creates incident with required fields: title, services, start, resolution', async () => {
         const incident = await createIncident(
            {
               title: 'Stellar Horizon rate limiting',
               services: ['horizon'],
               status: 'resolved',
               resolution: 'Upgraded rate limits with provider',
               start: '2026-10-15T10:00:00.000Z',
            },
            'GADMIN123456789012345678901234567890123456789012345678901234'
         );

         expect(incident.id).toMatch(/^inc_/);
         expect(incident.title).toBe('Stellar Horizon rate limiting');
         expect(incident.services).toEqual(['horizon']);
         expect(incident.status).toBe('resolved');
         expect(incident.resolution).toBe('Upgraded rate limits with provider');
         expect(incident.start).toBe('2026-10-15T10:00:00.000Z');
         expect(incident.startedAt).toBe('2026-10-15T10:00:00.000Z');
         expect(incident.createdBy).toBe(
            'GADMIN123456789012345678901234567890123456789012345678901234'
         );
      });

      it('paginates incident log with page and limit parameters', async () => {
         for (let i = 1; i <= 5; i++) {
            await createIncident({
               title: `Incident ${i}`,
               services: ['database'],
               start: new Date(Date.now() + i * 1000).toISOString(),
            });
         }

         const page1 = await getIncidents({ page: 1, limit: 2 });
         expect(page1.incidents).toHaveLength(2);
         expect(page1.pagination.page).toBe(1);
         expect(page1.pagination.pageSize).toBe(2);
         expect(page1.pagination.totalItems).toBe(5);
         expect(page1.pagination.totalPages).toBe(3);
         expect(page1.pagination.hasNextPage).toBe(true);

         const page2 = await getIncidents({ page: 2, limit: 2 });
         expect(page2.incidents).toHaveLength(2);
         expect(page2.pagination.page).toBe(2);

         const page3 = await getIncidents({ page: 3, limit: 2 });
         expect(page3.incidents).toHaveLength(1);
         expect(page3.pagination.hasNextPage).toBe(false);
      });
   });

   describe('Admin Wallet Guard (requireStatusAdminWallet)', () => {
      const adminWallet =
         'GBADMIN1234567890123456789012345678901234567890123456789012';
      const nonAdminWallet =
         'GBUSER12345678901234567890123456789012345678901234567890123';

      function mockRes(): Response & { statusCode: number; body: any } {
         const res: any = { statusCode: 200, body: null };
         res.status = (code: number) => {
            res.statusCode = code;
            return res;
         };
         res.json = (body: any) => {
            res.body = body;
            return res;
         };
         res.setHeader = jest.fn();
         return res;
      }

      it('returns 401 when no token is provided', async () => {
         const req = { headers: {} } as StatusAdminRequest;
         const res = mockRes();
         const next = jest.fn();

         await requireStatusAdminWallet(req, res, next);
         expect(res.statusCode).toBe(401);
         expect(next).not.toHaveBeenCalled();
      });

      it('returns 403 when authenticated wallet is not an admin wallet', async () => {
         setAdminWalletsForTesting([adminWallet]);
         const token = signWalletAccessToken(nonAdminWallet);

         const req = {
            headers: { authorization: `Bearer ${token}` },
         } as StatusAdminRequest;
         const res = mockRes();
         const next = jest.fn();

         await requireStatusAdminWallet(req, res, next);
         expect(res.statusCode).toBe(403);
         expect(next).not.toHaveBeenCalled();
      });

      it('allows request when authenticated wallet is in admin wallets', async () => {
         setAdminWalletsForTesting([adminWallet]);
         const token = signWalletAccessToken(adminWallet);

         const req = {
            headers: { authorization: `Bearer ${token}` },
         } as StatusAdminRequest;
         const res = mockRes();
         const next = jest.fn();

         await requireStatusAdminWallet(req, res, next);
         expect(next).toHaveBeenCalled();
         expect(req.adminWallet).toBe(adminWallet);
      });
   });
});
