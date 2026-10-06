// Integration test: search endpoint returns 200 with empty items array
// when no creators match the query.
//
// A search query that matches no creators should return 200 with an empty
// items array rather than a 404 or error response. The response shape must
// be identical to a non-empty result (same envelope, same pagination meta).
//
// Issue: #765

import supertest from 'supertest';
import app from '../../app';
import { prisma } from '../../utils/prisma.utils';

const USER_IDS = [
   'search-empty-user-alpha',
   'search-empty-user-beta',
];
const HANDLES = [
   'search-empty-alpha',
   'search-empty-beta',
];
const DISPLAY_NAMES = ['AlphaSearcher', 'BetaSearcher'];

describe('#765 search endpoint — empty results for non-matching query', () => {
   beforeAll(async () => {
      for (let i = 0; i < USER_IDS.length; i++) {
         await prisma.user.upsert({
            where: { id: USER_IDS[i] },
            create: {
               id: USER_IDS[i],
               email: `search-empty-${i}@example.test`,
               passwordHash: 'dummy-hash',
               firstName: 'Search',
               lastName: `Empty ${i}`,
            },
            update: {},
         });

         await prisma.creatorProfile.upsert({
            where: { handle: HANDLES[i] },
            create: {
               userId: USER_IDS[i],
               handle: HANDLES[i],
               displayName: DISPLAY_NAMES[i],
            },
            update: { displayName: DISPLAY_NAMES[i] },
         });
      }
   });

   afterAll(async () => {
      await prisma.creatorProfile.deleteMany({
         where: { handle: { in: HANDLES } },
      });
      await prisma.user.deleteMany({
         where: { id: { in: USER_IDS } },
      });
      await prisma.$disconnect();
   });

   it('returns 200 with an empty items array when the search matches no creators', async () => {
      const res = await supertest(app).get(
         '/api/v1/creators?search=zzz-nonexistent-query-999'
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data.items)).toBe(true);
      expect(res.body.data.items).toHaveLength(0);
   });

   it('returns hasMore=false and total=0 for a non-matching search', async () => {
      const res = await supertest(app).get(
         '/api/v1/creators?search=zzz-nonexistent-query-999'
      );

      expect(res.body.data.meta).toHaveProperty('hasMore', false);
      expect(res.body.data.meta).toHaveProperty('total', 0);
   });

   it('response shape matches a normal (non-empty) result envelope', async () => {
      const emptyRes = await supertest(app).get(
         '/api/v1/creators?search=zzz-nonexistent-query-999'
      );
      const nonEmptyRes = await supertest(app).get(
         '/api/v1/creators?search=AlphaSearcher'
      );

      // Both responses share the same top-level envelope shape
      expect(emptyRes.body).toHaveProperty('success');
      expect(emptyRes.body).toHaveProperty('data');
      expect(emptyRes.body.data).toHaveProperty('items');
      expect(emptyRes.body.data).toHaveProperty('meta');

      expect(nonEmptyRes.body).toHaveProperty('success');
      expect(nonEmptyRes.body).toHaveProperty('data');
      expect(nonEmptyRes.body.data).toHaveProperty('items');
      expect(nonEmptyRes.body.data).toHaveProperty('meta');

      // Both have the same meta shape
      const emptyMeta = emptyRes.body.data.meta;
      const nonEmptyMeta = nonEmptyRes.body.data.meta;

      expect(emptyMeta).toHaveProperty('limit');
      expect(emptyMeta).toHaveProperty('offset');
      expect(emptyMeta).toHaveProperty('total');
      expect(emptyMeta).toHaveProperty('hasMore');

      expect(nonEmptyMeta).toHaveProperty('limit');
      expect(nonEmptyMeta).toHaveProperty('offset');
      expect(nonEmptyMeta).toHaveProperty('total');
      expect(nonEmptyMeta).toHaveProperty('hasMore');

      // Meta keys are identical between empty and non-empty results
      expect(Object.keys(emptyMeta).sort()).toEqual(
         Object.keys(nonEmptyMeta).sort()
      );
   });

   it('returns HTTP 200, not 404, for a search with no matches', async () => {
      const res = await supertest(app).get(
         '/api/v1/creators?search=zzz-nonexistent-query-999'
      );

      expect(res.status).toBe(200);
      expect(res.status).not.toBe(404);
   });
});
