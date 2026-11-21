// src/modules/creators/creator-list-search-partial-name.integration.test.ts
// Integration test for #685 — creator search endpoint returns creators
// whose display name contains the query string, case-insensitively.

import supertest from 'supertest';
import app from '../../app';
import { prisma } from '../../utils/prisma.utils';

const USER_IDS = [
   'search-partial-user-alice',
   'search-partial-user-alicia',
   'search-partial-user-bob',
   'search-partial-user-bobby',
];
const HANDLES = [
   'search-partial-alice',
   'search-partial-alicia',
   'search-partial-bob',
   'search-partial-bobby',
];
const DISPLAY_NAMES = ['Alice', 'Alicia', 'Bob', 'Bobby'];

describe('#685 creator search — partial display name match', () => {
   let creatorIds: string[];

   beforeAll(async () => {
      creatorIds = [];

      for (let i = 0; i < DISPLAY_NAMES.length; i++) {
         await prisma.user.upsert({
            where: { id: USER_IDS[i] },
            create: {
               id: USER_IDS[i],
               email: `search-partial-${i}@example.test`,
               passwordHash: 'dummy-hash',
               firstName: 'Search',
               lastName: `Partial ${i}`,
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
      await prisma.user.deleteMany({ where: { id: { in: USER_IDS } } });
      await prisma.$disconnect();
   });

   function seededMatches(res: supertest.Response): any[] {
      return (res.body.data.items as any[]).filter((c: any) =>
         creatorIds.includes(c.id)
      );
   }

   it("'ali' returns Alice and Alicia only", async () => {
      const res = await supertest(app).get('/api/v1/creators?search=ali');
      expect(res.status).toBe(200);

      const names = seededMatches(res).map((c: any) => c.name);
      expect(names).toEqual(expect.arrayContaining(['Alice', 'Alicia']));
      expect(names).not.toEqual(expect.arrayContaining(['Bob', 'Bobby']));
   });

   it("'bob' returns Bob and Bobby only", async () => {
      const res = await supertest(app).get('/api/v1/creators?search=bob');
      expect(res.status).toBe(200);

      const names = seededMatches(res).map((c: any) => c.name);
      expect(names).toEqual(expect.arrayContaining(['Bob', 'Bobby']));
      expect(names).not.toEqual(expect.arrayContaining(['Alice', 'Alicia']));
   });

   it("'xyz' returns an empty array", async () => {
      const res = await supertest(app).get('/api/v1/creators?search=xyz');
      expect(res.status).toBe(200);

      expect(seededMatches(res)).toHaveLength(0);
   });

   it("'ALI' matches case-insensitively", async () => {
      const res = await supertest(app).get('/api/v1/creators?search=ALI');
      expect(res.status).toBe(200);

      const names = seededMatches(res).map((c: any) => c.name);
      expect(names).toEqual(expect.arrayContaining(['Alice', 'Alicia']));
   });

   it('each match includes an id and display name', async () => {
      const res = await supertest(app).get('/api/v1/creators?search=ali');
      expect(res.status).toBe(200);

      for (const item of seededMatches(res)) {
         expect(item).toHaveProperty('id');
         expect(item).toHaveProperty('name');
      }
   });
});
