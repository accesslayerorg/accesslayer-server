// src/modules/status/status.integration.test.ts
// Integration tests for platform status API endpoints (#1015).

import supertest from 'supertest';
import app from '../../app';
import {
   resetStatusStore,
   recordProbeForTesting,
} from './status.service';
import {
   setAdminWalletsForTesting,
   clearAdminWalletsForTesting,
} from './status.auth';
import { signWalletAccessToken } from '../../utils/jwt.utils';

describe('Platform Status API Integration Tests', () => {
   const adminWallet =
      'GAADMIN1234567890123456789012345678901234567890123456789012';
   const userWallet =
      'GAUSER12345678901234567890123456789012345678901234567890123';

   let adminToken: string;
   let userToken: string;

   beforeAll(async () => {
      adminToken = signWalletAccessToken(adminWallet);
      userToken = signWalletAccessToken(userWallet);
      // Warm up Express and middlewares so cold start does not affect timing assertions
      await supertest(app).get('/status');
   });

   beforeEach(() => {
      resetStatusStore();
      clearAdminWalletsForTesting();
      setAdminWalletsForTesting([adminWallet]);
   });

   describe('GET /status & GET /api/v1/status', () => {
      it('responds within 500ms and returns current service states and timestamps', async () => {
         recordProbeForTesting('database', 'operational');
         recordProbeForTesting('redis', 'operational');
         recordProbeForTesting('horizon', 'operational');
         recordProbeForTesting('soroban-rpc', 'operational');
         recordProbeForTesting('indexer', 'operational');

         const start = Date.now();
         const res = await supertest(app).get('/status');
         const duration = Date.now() - start;

         expect(duration).toBeLessThan(500);
         expect(res.status).toBe(200);
         expect(res.body.success).toBe(true);
         expect(res.body.status).toBe('operational');
         expect(Array.isArray(res.body.services)).toBe(true);
         expect(res.body.services.length).toBe(5);

         for (const s of res.body.services) {
            expect(s).toHaveProperty('name');
            expect(s).toHaveProperty('status');
            expect(s).toHaveProperty('lastChecked');
            expect(s).toHaveProperty('lastCheckedAt');
         }
      });

      it('is accessible via /api/v1/status as well', async () => {
         recordProbeForTesting('database', 'operational');
         recordProbeForTesting('redis', 'operational');

         const res = await supertest(app).get('/api/v1/status');
         expect(res.status).toBe(200);
         expect(res.body.success).toBe(true);
      });
   });

   describe('GET /status/history', () => {
      it('returns 30-day uptime percentage per service', async () => {
         for (let i = 0; i < 9; i++) {
            recordProbeForTesting('database', 'operational');
         }
         recordProbeForTesting('database', 'down');

         const res = await supertest(app).get('/status/history?windowDays=30');

         expect(res.status).toBe(200);
         expect(res.body.success).toBe(true);
         expect(res.body.windowDays).toBe(30);
         expect(Array.isArray(res.body.services)).toBe(true);

         const dbService = res.body.services.find((s: any) => s.name === 'database');
         expect(dbService).toBeDefined();
         expect(dbService.uptimePercentage).toBe(90);
         expect(dbService.totalChecks).toBe(10);
         expect(dbService.successfulChecks).toBe(9);
      });
   });

   describe('POST /status/incidents (Admin Only)', () => {
      it('rejects unauthenticated requests with 401', async () => {
         const res = await supertest(app)
            .post('/status/incidents')
            .send({
               title: 'Horizon downtime',
               services: ['horizon'],
            });

         expect(res.status).toBe(401);
      });

      it('rejects non-admin wallet with 403', async () => {
         const res = await supertest(app)
            .post('/status/incidents')
            .set('Authorization', `Bearer ${userToken}`)
            .send({
               title: 'Horizon downtime',
               services: ['horizon'],
            });

         expect(res.status).toBe(403);
         expect(res.body.error.message).toContain('Admin authorization required');
      });

      it('rejects invalid payload with 400', async () => {
         const res = await supertest(app)
            .post('/status/incidents')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({
               title: '',
               services: [],
            });

         expect(res.status).toBe(400);
         expect(res.body.error.code).toBe('VALIDATION_ERROR');
      });

      it('allows authorized admin wallet to create an incident record (201)', async () => {
         const payload = {
            title: 'Soroban RPC Maintenance',
            services: ['soroban-rpc'],
            status: 'resolved',
            impact: 'minor',
            start: '2026-10-16T08:00:00.000Z',
            resolution: 'Node upgraded successfully',
            resolvedAt: '2026-10-16T09:00:00.000Z',
         };

         const res = await supertest(app)
            .post('/status/incidents')
            .set('Authorization', `Bearer ${adminToken}`)
            .send(payload);

         expect(res.status).toBe(201);
         expect(res.body.success).toBe(true);
         expect(res.body.incident).toBeDefined();
         expect(res.body.incident.id).toMatch(/^inc_/);
         expect(res.body.incident.title).toBe(payload.title);
         expect(res.body.incident.services).toEqual(payload.services);
         expect(res.body.incident.status).toBe('resolved');
         expect(res.body.incident.resolution).toBe(payload.resolution);
         expect(res.body.incident.start).toBe(payload.start);
         expect(res.body.incident.startedAt).toBe(payload.start);
      });
   });

   describe('GET /status/incidents (Paginated Log)', () => {
      beforeEach(async () => {
         for (let i = 1; i <= 6; i++) {
            await supertest(app)
               .post('/status/incidents')
               .set('Authorization', `Bearer ${adminToken}`)
               .send({
                  title: `Incident ${i}`,
                  services: [i % 2 === 0 ? 'redis' : 'database'],
                  start: new Date(Date.now() - i * 60000).toISOString(),
                  resolution: i <= 3 ? 'Resolved' : null,
                  status: i <= 3 ? 'resolved' : 'investigating',
               });
         }
      });

      it('returns all incidents with correct fields and pagination', async () => {
         const res = await supertest(app).get('/status/incidents?page=1&limit=4');

         expect(res.status).toBe(200);
         expect(res.body.success).toBe(true);
         expect(Array.isArray(res.body.incidents)).toBe(true);
         expect(res.body.incidents.length).toBe(4);

         const incident = res.body.incidents[0];
         expect(incident).toHaveProperty('id');
         expect(incident).toHaveProperty('title');
         expect(incident).toHaveProperty('services');
         expect(incident).toHaveProperty('start');
         expect(incident).toHaveProperty('resolution');
         expect(incident).toHaveProperty('status');

         expect(res.body.pagination).toEqual(
            expect.objectContaining({
               page: 1,
               pageSize: 4,
               totalItems: 6,
               totalPages: 2,
               hasNextPage: true,
               hasPreviousPage: false,
            })
         );
      });

      it('filters incidents by service and status', async () => {
         const res = await supertest(app).get(
            '/status/incidents?service=redis&status=resolved'
         );

         expect(res.status).toBe(200);
         expect(res.body.incidents.length).toBeGreaterThan(0);
         for (const inc of res.body.incidents) {
            expect(inc.services).toContain('redis');
            expect(inc.status).toBe('resolved');
         }
      });
   });
});
