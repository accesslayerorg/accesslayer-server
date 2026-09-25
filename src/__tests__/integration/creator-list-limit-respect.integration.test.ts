import supertest from 'supertest';
import app from '../../app';
import { prisma } from '../../utils/prisma.utils';

const FIXTURE_SIZE = 20;

describe('GET /api/v1/creators — limit query parameter', () => {
   beforeAll(async () => {
      // Clear out existing creators and users so that we only have the seeded ones for this test
      // to ensure "assert exactly 20 returned" works perfectly.
      await prisma.creatorProfile.deleteMany({});
      await prisma.user.deleteMany({});

      // Seed test users
      const usersToCreate = Array.from({ length: FIXTURE_SIZE }).map(
         (_, i) => ({
            id: `limit-respect-user-${i}`,
            email: `limit-respect-user-${i}@example.com`,
            passwordHash: 'dummy-hash',
            firstName: 'Limit',
            lastName: `Respect User ${i}`,
         })
      );

      await prisma.user.createMany({
         data: usersToCreate,
         skipDuplicates: true,
      });

      // Seed test creators
      const creatorsToCreate = Array.from({ length: FIXTURE_SIZE }).map(
         (_, i) => ({
            userId: `limit-respect-user-${i}`,
            handle: `limit-respect-creator-${i}`,
            displayName: `Limit Respect Creator ${i}`,
         })
      );

      await prisma.creatorProfile.createMany({
         data: creatorsToCreate,
         skipDuplicates: true,
      });
   });

   afterAll(async () => {
      // Cleanup
      await prisma.creatorProfile.deleteMany({
         where: { handle: { startsWith: 'limit-respect-creator-' } },
      });

      await prisma.user.deleteMany({
         where: { id: { startsWith: 'limit-respect-user-' } },
      });

      await prisma.$disconnect();
   });

   it('returns exactly 5 creators when limit=5 and has_more is true', async () => {
      const res = await supertest(app).get('/api/v1/creators?limit=5');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.items).toHaveLength(5);
      expect(res.body.data.meta.has_more).toBe(true);
      expect(res.body.data.meta.limit).toBe(5);
   });

   it('returns exactly 10 creators when limit=10 and has_more is true', async () => {
      const res = await supertest(app).get('/api/v1/creators?limit=10');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.items).toHaveLength(10);
      expect(res.body.data.meta.has_more).toBe(true);
      expect(res.body.data.meta.limit).toBe(10);
   });

   it('returns all 20 creators when limit=100 (above seed count) and has_more is false', async () => {
      const res = await supertest(app).get('/api/v1/creators?limit=100');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      expect(res.body.data.items).toHaveLength(20);
      expect(res.body.data.meta.has_more).toBe(false);
      expect(res.body.data.meta.limit).toBe(100);
   });
});
