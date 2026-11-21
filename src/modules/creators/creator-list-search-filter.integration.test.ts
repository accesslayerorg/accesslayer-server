// src/modules/creators/creator-list-search-filter.integration.test.ts
// Integration tests for #610 — partial, case-insensitive name search on the
// creator list endpoint.

import supertest from 'supertest';
import app from '../../app';
import { prisma } from '../../utils/prisma.utils';

const USER_IDS = [
   'search-filter-user-alpha',
   'search-filter-user-alphatwo',
   'search-filter-user-beta',
];
const HANDLES = [
   'search-filter-alpha',
   'search-filter-alphatwo',
   'search-filter-beta',
];
const DISPLAY_NAMES = ['Alpha', 'AlphaTwo', 'Beta'];

describe('#610 creator list search (partial name match)', () => {
   let creatorIds: string[];

   beforeAll(async () => {
      creatorIds = [];

      for (let i = 0; i < 3; i++) {
         await prisma.user.upsert({
            where: { id: USER_IDS[i] },
            create: {
               id: USER_IDS[i],
               email: `search-filter-${i}@example.test`,
               passwordHash: 'dummy-hash',
               firstName: 'Search',
               lastName: `Filter ${i}`,
            },
            update: {},
         });

         const creator = await prisma.creatorProfile.upsert({
            where: { handle: HANDLES[i] },
            create: {
               userId: USER_IDS[i],
               handle: HANDLES[i],
               displayName: DISPLAY_NAMES[i],
            },
            update: { displayName: DISPLAY_NAMES[i] },
         });

         creatorIds.push(creator.id);
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

   it('returns both Alpha and AlphaTwo, and excludes Beta, for a case-insensitive partial match', async () => {
      const res = await supertest(app).get('/api/v1/creators?search=alpha');
      expect(res.status).toBe(200);

      const ids = (res.body.data.items as any[])
         .filter((c: any) => creatorIds.includes(c.id))
         .map((c: any) => c.id);

      expect(ids).toContain(creatorIds[0]); // Alpha
      expect(ids).toContain(creatorIds[1]); // AlphaTwo
      expect(ids).not.toContain(creatorIds[2]); // Beta
   });

   it('matches regardless of search term casing', async () => {
      const res = await supertest(app).get('/api/v1/creators?search=ALPHA');
      expect(res.status).toBe(200);

      const ids = (res.body.data.items as any[])
         .filter((c: any) => creatorIds.includes(c.id))
         .map((c: any) => c.id);

      expect(ids).toContain(creatorIds[0]);
      expect(ids).toContain(creatorIds[1]);
      expect(ids).not.toContain(creatorIds[2]);
   });

   it('returns all seeded creators when the search string is empty', async () => {
      const res = await supertest(app).get('/api/v1/creators?search=');
      expect(res.status).toBe(200);

      const ids = (res.body.data.items as any[])
         .filter((c: any) => creatorIds.includes(c.id))
         .map((c: any) => c.id);

      expect(ids).toContain(creatorIds[0]);
      expect(ids).toContain(creatorIds[1]);
      expect(ids).toContain(creatorIds[2]);
   });

   it('returns no seeded creators for a search term that matches none of them', async () => {
      const res = await supertest(app).get(
         '/api/v1/creators?search=zzz-no-match-zzz'
      );
      expect(res.status).toBe(200);

      const ids = (res.body.data.items as any[])
         .filter((c: any) => creatorIds.includes(c.id))
         .map((c: any) => c.id);

      expect(ids).toHaveLength(0);
   });
});
