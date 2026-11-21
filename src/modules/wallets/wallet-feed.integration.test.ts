// Integration test: GET /api/v1/wallets/:address/feed
//
// Verifies that the feed includes posts only from creators followed by the
// authenticated wallet and is empty after its last follow is removed.

import supertest from 'supertest';
import { Keypair } from '@stellar/stellar-base';
import app from '../../app';
import { prisma } from '../../utils/prisma.utils';
import { signWalletAccessToken } from '../../utils/jwt.utils';

describe('GET /api/v1/wallets/:address/feed', () => {
   const prefix = `wallet-feed-${Date.now()}`;
   const walletA = Keypair.random();
   const walletX = Keypair.random();
   const walletY = Keypair.random();

   const creatorXId = `${prefix}-creator-x`;
   const creatorYId = `${prefix}-creator-y`;
   const postXContent = `${prefix} post from creator X`;
   const postYContent = `${prefix} post from creator Y`;
   const seededPosts = [
      {
         id: `${prefix}-post-x`,
         creatorId: creatorXId,
         content: postXContent,
         createdAt: new Date('2026-01-01T00:00:00.000Z'),
         creator: { user: { stellarWallet: { address: walletX.publicKey() } } },
      },
      {
         id: `${prefix}-post-y`,
         creatorId: creatorYId,
         content: postYContent,
         createdAt: new Date('2026-01-02T00:00:00.000Z'),
         creator: { user: { stellarWallet: { address: walletY.publicKey() } } },
      },
   ];
   const followedCreatorIds = new Set<string>([creatorXId]);

   beforeAll(async () => {
      (prisma.creatorPost.findMany as jest.Mock).mockImplementation(
         async (args: {
            where: {
               creator: {
                  walletFollowers: {
                     some: { walletAddress: string };
                  };
               };
            };
         }) => {
            const address =
               args.where.creator.walletFollowers.some.walletAddress;
            return seededPosts
               .filter(
                  post =>
                     address === walletA.publicKey() &&
                     followedCreatorIds.has(post.creatorId)
               )
               .map(({ creatorId: _creatorId, ...post }) => post);
         }
      );
      (prisma.walletCreatorFollow.deleteMany as jest.Mock).mockImplementation(
         async (args: {
            where: { walletAddress: string; creatorId: string };
         }) => {
            if (args.where.walletAddress === walletA.publicKey()) {
               followedCreatorIds.delete(args.where.creatorId);
            }
            return { count: 1 };
         }
      );
   });

   afterAll(async () => {
      jest.restoreAllMocks();
   });

   it('returns 401 for an unauthenticated request', async () => {
      const res = await supertest(app).get(
         `/api/v1/wallets/${walletA.publicKey()}/feed`
      );

      expect(res.status).toBe(401);
   });

   it('returns posts only from creators the wallet follows', async () => {
      const token = signWalletAccessToken(walletA.publicKey(), `${prefix}-user-a`);
      const res = await supertest(app)
         .get(`/api/v1/wallets/${walletA.publicKey()}/feed`)
         .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.map((post: { content: string }) => post.content))
         .toEqual([postXContent]);
      expect(prisma.creatorPost.findMany).toHaveBeenCalledWith(
         expect.objectContaining({
            where: {
               creator: {
                  walletFollowers: {
                     some: { walletAddress: walletA.publicKey() },
                  },
               },
            },
         })
      );
   });

   it('returns an empty feed after the wallet unfollows its last creator', async () => {
      await prisma.walletCreatorFollow.deleteMany({
         where: {
            walletAddress: walletA.publicKey(),
            creatorId: creatorXId,
         },
      });

      const token = signWalletAccessToken(walletA.publicKey(), `${prefix}-user-a`);
      const res = await supertest(app)
         .get(`/api/v1/wallets/${walletA.publicKey()}/feed`)
         .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual([]);
   });
});
