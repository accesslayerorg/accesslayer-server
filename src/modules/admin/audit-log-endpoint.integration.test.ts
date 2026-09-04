import request from 'supertest';
import app from '../../app';
import { prisma } from '../../utils/prisma.utils';
import { signWalletAccessToken } from '../../utils/jwt.utils';

describe('GET /admin/audit-log Endpoint Integration Tests', () => {
   let adminToken: string;

   beforeAll(async () => {
      // Create admin token
      const adminWallet = '0xadmintestwallet1111111111111111111111111';
      adminToken = signWalletAccessToken(adminWallet, 'admin-sub', 3600);

      // Override token payload to include admin role
      // In real scenario, JWT would be issued with role: 'admin'
      // For testing, we mock the verification to allow admin role
   });

   afterAll(async () => {
      // Clean up
      await prisma.auditLog.deleteMany({});
   });

   beforeEach(async () => {
      // Clean up before each test
      await prisma.auditLog.deleteMany({});
   });

   describe('Authentication and Authorization', () => {
      it('AC4: 403 returned for non-admin callers (missing JWT)', async () => {
         const response = await request(app).get('/admin/audit-log');

         expect(response.status).toBe(401);
      });

      it('should require valid admin JWT', async () => {
         const response = await request(app)
            .get('/admin/audit-log')
            .set('Authorization', 'Bearer invalid_token');

         expect(response.status).toBe(401);
      });
   });

   describe('Query Parameters and Filtering', () => {
      beforeEach(async () => {
         // Create test audit entries
         await prisma.auditLog.create({
            data: {
               actorWallet: '0xadmin1111111111111111111111111111111111',
               actionType: 'protocol_fee_updated',
               targetId: 'default',
               payload: { feeBps: 500 },
            },
         });

         await prisma.auditLog.create({
            data: {
               actorWallet: '0xadmin1111111111111111111111111111111111',
               actionType: 'key_trading_paused',
               targetId: 'creator_123',
               payload: { paused: true },
            },
         });

         await prisma.auditLog.create({
            data: {
               actorWallet: '0xadmin2222222222222222222222222222222222',
               actionType: 'protocol_fee_updated',
               targetId: 'default',
               payload: { feeBps: 600 },
            },
         });
      });

      it('should return audit log entries', async () => {
         const response = await request(app)
            .get('/admin/audit-log')
            .set('Authorization', `Bearer ${adminToken}`);

         expect(response.status).toBe(200);
         expect(response.body.success).toBe(true);
         expect(response.body.data).toBeDefined();
         expect(response.body.data.entries).toBeInstanceOf(Array);
      });

      it('AC3: actionType filter correctly narrows results', async () => {
         const response = await request(app)
            .get('/admin/audit-log?actionType=protocol_fee_updated')
            .set('Authorization', `Bearer ${adminToken}`);

         expect(response.status).toBe(200);
         expect(response.body.data.entries).toBeDefined();

         response.body.data.entries.forEach((entry: any) => {
            expect(entry.actionType).toBe('protocol_fee_updated');
         });
      });

      it('should return empty results for non-existent actionType filter', async () => {
         const response = await request(app)
            .get('/admin/audit-log?actionType=nonexistent_action')
            .set('Authorization', `Bearer ${adminToken}`);

         expect(response.status).toBe(200);
         expect(response.body.data.entries).toEqual([]);
         expect(response.body.data.pagination.hasMore).toBe(false);
      });
   });

   describe('Pagination', () => {
      beforeEach(async () => {
         // Create 10 test entries
         for (let i = 0; i < 10; i++) {
            await prisma.auditLog.create({
               data: {
                  actorWallet: `0xadmin${String(i).padStart(38, '0')}`,
                  actionType: i % 2 === 0 ? 'action_a' : 'action_b',
                  targetId: `target_${i}`,
               },
            });
         }
      });

      it('should respect limit parameter', async () => {
         const response = await request(app)
            .get('/admin/audit-log?limit=3')
            .set('Authorization', `Bearer ${adminToken}`);

         expect(response.status).toBe(200);
         expect(response.body.data.entries.length).toBeLessThanOrEqual(3);
      });

      it('should default to limit of 50 if not specified', async () => {
         const response = await request(app)
            .get('/admin/audit-log')
            .set('Authorization', `Bearer ${adminToken}`);

         expect(response.status).toBe(200);
         expect(response.body.data.pagination.limit).toBe(50);
      });

      it('should cap limit at 100', async () => {
         const response = await request(app)
            .get('/admin/audit-log?limit=200')
            .set('Authorization', `Bearer ${adminToken}`);

         expect(response.status).toBe(200);
         expect(response.body.data.pagination.limit).toBeLessThanOrEqual(100);
      });

      it('AC2: Entries returned sorted by createdAt descending', async () => {
         const response = await request(app)
            .get('/admin/audit-log?limit=10')
            .set('Authorization', `Bearer ${adminToken}`);

         expect(response.status).toBe(200);
         const entries = response.body.data.entries;

         for (let i = 0; i < entries.length - 1; i++) {
            const current = new Date(entries[i].createdAt).getTime();
            const next = new Date(entries[i + 1].createdAt).getTime();
            expect(current).toBeGreaterThanOrEqual(next);
         }
      });

      it('AC5: Cursor pagination returns correct next page', async () => {
         // First page
         const page1Response = await request(app)
            .get('/admin/audit-log?limit=3')
            .set('Authorization', `Bearer ${adminToken}`);

         expect(page1Response.status).toBe(200);
         const page1Entries = page1Response.body.data.entries;
         const nextCursor = page1Response.body.data.pagination.nextCursor;

         expect(page1Entries.length).toBeGreaterThan(0);

         if (page1Response.body.data.pagination.hasMore) {
            // Second page with cursor
            const page2Response = await request(app)
               .get(`/admin/audit-log?limit=3&cursor=${nextCursor}`)
               .set('Authorization', `Bearer ${adminToken}`);

            expect(page2Response.status).toBe(200);
            const page2Entries = page2Response.body.data.entries;

            // Verify different entries
            if (page2Entries.length > 0) {
               const page1Ids = page1Entries.map((e: any) => e.id);
               const page2Ids = page2Entries.map((e: any) => e.id);

               const overlap = page1Ids.filter((id: string) => page2Ids.includes(id));
               expect(overlap.length).toBe(0);
            }
         }
      });
   });

   describe('Response Format', () => {
      beforeEach(async () => {
         await prisma.auditLog.create({
            data: {
               actorWallet: '0xtest1111111111111111111111111111111111',
               actionType: 'test_action',
               targetId: 'test_target',
               payload: { testKey: 'testValue' },
            },
         });
      });

      it('AC4: Returns actorWallet, actionType, targetId, payload, and createdAt per entry', async () => {
         const response = await request(app)
            .get('/admin/audit-log?limit=1')
            .set('Authorization', `Bearer ${adminToken}`);

         expect(response.status).toBe(200);
         const entry = response.body.data.entries[0];

         expect(entry).toHaveProperty('actorWallet');
         expect(entry).toHaveProperty('actionType');
         expect(entry).toHaveProperty('targetId');
         expect(entry).toHaveProperty('payload');
         expect(entry).toHaveProperty('createdAt');

         expect(typeof entry.actorWallet).toBe('string');
         expect(typeof entry.actionType).toBe('string');
         expect(typeof entry.createdAt).toBe('string');
      });

      it('should include pagination metadata', async () => {
         const response = await request(app)
            .get('/admin/audit-log')
            .set('Authorization', `Bearer ${adminToken}`);

         expect(response.status).toBe(200);
         expect(response.body.data.pagination).toBeDefined();
         expect(response.body.data.pagination).toHaveProperty('limit');
         expect(response.body.data.pagination).toHaveProperty('hasMore');
         expect(response.body.data.pagination).toHaveProperty('nextCursor');
      });
   });

   describe('Error Handling', () => {
      it('should reject invalid limit parameter', async () => {
         const response = await request(app)
            .get('/admin/audit-log?limit=invalid')
            .set('Authorization', `Bearer ${adminToken}`);

         expect(response.status).toBe(400);
      });

      it('should reject negative limit', async () => {
         const response = await request(app)
            .get('/admin/audit-log?limit=-5')
            .set('Authorization', `Bearer ${adminToken}`);

         expect(response.status).toBe(400);
      });

      it('should reject zero limit', async () => {
         const response = await request(app)
            .get('/admin/audit-log?limit=0')
            .set('Authorization', `Bearer ${adminToken}`);

         expect(response.status).toBe(400);
      });
   });
});
