// Integration test: GET /api/v1/creators/:id/posts
//
// Verifies that the post list endpoint is scoped to the requested creator.
// Seeds posts from two different creators and confirms only the requested
// creator's posts are returned, with the correct count and no leakage.

import supertest from 'supertest';
import { Keypair } from '@stellar/stellar-base';
import app from '../../app';
import { prisma } from '../../utils/prisma.utils';

describe('GET /api/v1/creators/:id/posts — creator scoping', () => {
   const creatorAId = 'post-scope-creator-a';
   const creatorBId = 'post-scope-creator-b';
   const userAId = 'post-scope-user-a';
   const userBId = 'post-scope-user-b';
   const walletA = Keypair.random();
   const walletB = Keypair.random();

   const creatorAPostContents = ['Creator A post 1', 'Creator A post 2'];
   const creatorBPostContents = [
      'Creator B post 1',
      'Creator B post 2',
      'Creator B post 3',
   ];

   beforeAll(async () => {
      // Seed users (must exist before wallets due to FK)
      await prisma.user.createMany({
         data: [
            {
               id: userAId,
               email: 'post-scope-a@example.com',
               passwordHash: 'hash',
               firstName: 'Post',
               lastName: 'Scope A',
            },
            {
               id: userBId,
               email: 'post-scope-b@example.com',
               passwordHash: 'hash',
               firstName: 'Post',
               lastName: 'Scope B',
            },
         ],
         skipDuplicates: true,
      });

      // Seed wallets linked to users
      await prisma.stellarWallet.createMany({
         data: [
            { userId: userAId, address: walletA.publicKey() },
            { userId: userBId, address: walletB.publicKey() },
         ],
         skipDuplicates: true,
      });

      // Seed creator profiles
      await prisma.creatorProfile.createMany({
         data: [
            {
               id: creatorAId,
               userId: userAId,
               handle: 'post-scope-creator-a',
               displayName: 'Creator A',
            },
            {
               id: creatorBId,
               userId: userBId,
               handle: 'post-scope-creator-b',
               displayName: 'Creator B',
            },
         ],
         skipDuplicates: true,
      });

      // Seed 2 posts for creator A
      await prisma.creatorPost.createMany({
         data: creatorAPostContents.map((content) => ({
            creatorId: creatorAId,
            content,
         })),
      });

      // Seed 3 posts for creator B
      await prisma.creatorPost.createMany({
         data: creatorBPostContents.map((content) => ({
            creatorId: creatorBId,
            content,
         })),
      });
   });

   afterAll(async () => {
      // Cleanup in reverse dependency order
      await prisma.creatorPost.deleteMany({
         where: { creatorId: { in: [creatorAId, creatorBId] } },
      });
      await prisma.creatorProfile.deleteMany({
         where: { id: { in: [creatorAId, creatorBId] } },
      });
      await prisma.stellarWallet.deleteMany({
         where: { userId: { in: [userAId, userBId] } },
      });
      await prisma.user.deleteMany({
         where: { id: { in: [userAId, userBId] } },
      });
   });

   it('returns exactly 2 posts for creator A', async () => {
      const res = await supertest(app).get(
         `/api/v1/creators/${creatorAId}/posts`
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(2);
   });

   it('returns only creator A posts when requesting creator A', async () => {
      const res = await supertest(app).get(
         `/api/v1/creators/${creatorAId}/posts`
      );

      const contents = res.body.data.map((p: any) => p.content);
      expect(contents).toEqual(
         expect.arrayContaining([
            'Creator A post 1',
            'Creator A post 2',
         ])
      );
   });

   it('returns none of creator B posts when requesting creator A', async () => {
      const res = await supertest(app).get(
         `/api/v1/creators/${creatorAId}/posts`
      );

      const contents = res.body.data.map((p: any) => p.content);
      for (const bContent of creatorBPostContents) {
         expect(contents).not.toContain(bContent);
      }
   });

   it('returns exactly 3 posts for creator B', async () => {
      const res = await supertest(app).get(
         `/api/v1/creators/${creatorBId}/posts`
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(3);
   });

   it('returns only creator B posts when requesting creator B', async () => {
      const res = await supertest(app).get(
         `/api/v1/creators/${creatorBId}/posts`
      );

      const contents = res.body.data.map((p: any) => p.content);
      expect(contents).toEqual(
         expect.arrayContaining([
            'Creator B post 1',
            'Creator B post 2',
            'Creator B post 3',
         ])
      );
   });

   it('returns none of creator A posts when requesting creator B', async () => {
      const res = await supertest(app).get(
         `/api/v1/creators/${creatorBId}/posts`
      );

      const contents = res.body.data.map((p: any) => p.content);
      for (const aContent of creatorAPostContents) {
         expect(contents).not.toContain(aContent);
      }
   });
});
