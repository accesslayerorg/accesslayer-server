import supertest from 'supertest';
import app from '../../app';
import { prisma } from '../../utils/prisma.utils';

const CREATOR_FIXTURE_SIZE = 500;
const RESPONSE_TIME_BUDGET_MS = 2000;

describe('Creator List Load Test', () => {
   // NOTE: This test should be run in isolation using --runInBand to avoid interference 
   // from other tests that might be hitting the database simultaneously.

   beforeAll(async () => {
      // 1. Seed Users
      const usersToCreate = Array.from({ length: CREATOR_FIXTURE_SIZE }).map((_, i) => ({
         id: `load-test-user-${i}`,
         email: `load-test-user-${i}@example.com`,
         passwordHash: 'dummy-hash',
         firstName: 'Load',
         lastName: `TestUser ${i}`,
      }));

      await prisma.user.createMany({
         data: usersToCreate,
         skipDuplicates: true,
      });

      // 2. Seed CreatorProfiles
      const creatorsToCreate = Array.from({ length: CREATOR_FIXTURE_SIZE }).map((_, i) => ({
         userId: `load-test-user-${i}`,
         handle: `load-test-creator-${i}`,
         displayName: `Load Test Creator ${i}`,
      }));

      await prisma.creatorProfile.createMany({
         data: creatorsToCreate,
         skipDuplicates: true,
      });
   });

   afterAll(async () => {
      // Teardown: delete only the seeded records.
      // CreatorProfile has a relation to User with onDelete: Cascade,
      // but deleting both explicitly by our naming convention ensures a clean state.

      await prisma.creatorProfile.deleteMany({
         where: { handle: { startsWith: 'load-test-creator-' } },
      });

      await prisma.user.deleteMany({
         where: { id: { startsWith: 'load-test-user-' } },
      });

      await prisma.$disconnect();
   });

   it(`should respond within ${RESPONSE_TIME_BUDGET_MS}ms for a list of creators and fail if the budget is exceeded`, async () => {
      const start = Date.now();

      const res = await supertest(app).get('/api/v1/creators');

      const elapsedMs = Date.now() - start;

      expect(res.status).toBe(200);
      expect(elapsedMs).toBeLessThanOrEqual(RESPONSE_TIME_BUDGET_MS);
   });
});
