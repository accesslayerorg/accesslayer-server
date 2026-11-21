// Integration test: GET /api/v1/wallets/:address/following
//
// Verifies that the following list endpoint returns all creators a wallet
// follows, ordered alphabetically by display name. Also verifies that an
// empty array is returned for a wallet with no follows and that unauthenticated
// requests receive 401.

import supertest from 'supertest';
import { Keypair } from '@stellar/stellar-base';
import app from '../../app';
import { prisma } from '../../utils/prisma.utils';
import { signWalletAccessToken } from '../../utils/jwt.utils';

describe('GET /api/v1/wallets/:address/following', () => {
   const PREFIX = 'wallet-following-test';
   const walletA = Keypair.random();
   const walletB = Keypair.random(); // wallet with no follows

   const userIdA = `${PREFIX}-user-a`;
   const userIdB = `${PREFIX}-user-b`;
   const userIdC = `${PREFIX}-user-c`;
   const userIdWalletA = `${PREFIX}-user-wallet-a`;
   const userIdWalletB = `${PREFIX}-user-wallet-b`;

   const creatorAId = `${PREFIX}-creator-a`; // 'Alice'
   const creatorBId = `${PREFIX}-creator-b`; // 'Mike'
   const creatorCId = `${PREFIX}-creator-c`; // 'Zara'

   beforeAll(async () => {
      // Seed users
      await prisma.user.createMany({
         data: [
            {
               id: userIdA,
               email: `${userIdA}@example.test`,
               passwordHash: 'hash',
               firstName: 'Follow',
               lastName: 'Test A',
            },
            {
               id: userIdB,
               email: `${userIdB}@example.test`,
               passwordHash: 'hash',
               firstName: 'Follow',
               lastName: 'Test B',
            },
            {
               id: userIdC,
               email: `${userIdC}@example.test`,
               passwordHash: 'hash',
               firstName: 'Follow',
               lastName: 'Test C',
            },
            {
               id: userIdWalletA,
               email: `${userIdWalletA}@example.test`,
               passwordHash: 'hash',
               firstName: 'Wallet',
               lastName: 'A',
            },
            {
               id: userIdWalletB,
               email: `${userIdWalletB}@example.test`,
               passwordHash: 'hash',
               firstName: 'Wallet',
               lastName: 'B',
            },
         ],
         skipDuplicates: true,
      });

      // Seed wallets
      await prisma.stellarWallet.createMany({
         data: [
            { userId: userIdWalletA, address: walletA.publicKey() },
            { userId: userIdWalletB, address: walletB.publicKey() },
         ],
         skipDuplicates: true,
      });

      // Seed creator profiles (in reverse alphabetical order to test sorting)
      await prisma.creatorProfile.createMany({
         data: [
            {
               id: creatorCId,
               userId: userIdC,
               handle: `${PREFIX}-handle-c`,
               displayName: 'Zara',
            },
            {
               id: creatorAId,
               userId: userIdA,
               handle: `${PREFIX}-handle-a`,
               displayName: 'Alice',
            },
            {
               id: creatorBId,
               userId: userIdB,
               handle: `${PREFIX}-handle-b`,
               displayName: 'Mike',
            },
         ],
         skipDuplicates: true,
      });

      // Seed follows: wallet A follows all three creators
      await prisma.walletCreatorFollow.createMany({
         data: [
            {
               walletAddress: walletA.publicKey(),
               creatorId: creatorCId,
            },
            {
               walletAddress: walletA.publicKey(),
               creatorId: creatorAId,
            },
            {
               walletAddress: walletA.publicKey(),
               creatorId: creatorBId,
            },
         ],
         skipDuplicates: true,
      });
   });

   afterAll(async () => {
      // Cleanup in reverse dependency order
      await prisma.walletCreatorFollow.deleteMany({
         where: {
            walletAddress: { in: [walletA.publicKey(), walletB.publicKey()] },
         },
      });
      await prisma.creatorProfile.deleteMany({
         where: { id: { in: [creatorAId, creatorBId, creatorCId] } },
      });
      await prisma.stellarWallet.deleteMany({
         where: {
            userId: { in: [userIdWalletA, userIdWalletB] },
         },
      });
      await prisma.user.deleteMany({
         where: {
            id: {
               in: [
                  userIdA,
                  userIdB,
                  userIdC,
                  userIdWalletA,
                  userIdWalletB,
               ],
            },
         },
      });
   });

   // ── Authentication ───────────────────────────────────────────────────────

   it('returns 401 for an unauthenticated request', async () => {
      const res = await supertest(app).get(
         `/api/v1/wallets/${walletA.publicKey()}/following`
      );

      expect(res.status).toBe(401);
   });

   // ── Alphabetical ordering ────────────────────────────────────────────────

   it('returns creators in alphabetical order by display name', async () => {
      const token = signWalletAccessToken(walletA.publicKey(), userIdWalletA);

      const res = await supertest(app)
         .get(`/api/v1/wallets/${walletA.publicKey()}/following`)
         .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const displayNames = res.body.data.map((c: any) => c.displayName);
      expect(displayNames).toEqual(['Alice', 'Mike', 'Zara']);
   });

   // ── Completeness ─────────────────────────────────────────────────────────

   it('returns all followed creators', async () => {
      const token = signWalletAccessToken(walletA.publicKey(), userIdWalletA);

      const res = await supertest(app)
         .get(`/api/v1/wallets/${walletA.publicKey()}/following`)
         .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(3);

      const ids = res.body.data.map((c: any) => c.id).sort();
      expect(ids).toEqual(
         [creatorAId, creatorBId, creatorCId].sort()
      );
   });

   // ── Empty array for wallet with no follows ───────────────────────────────

   it('returns an empty array for a wallet that follows no one', async () => {
      const token = signWalletAccessToken(walletB.publicKey(), userIdWalletB);

      const res = await supertest(app)
         .get(`/api/v1/wallets/${walletB.publicKey()}/following`)
         .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual([]);
   });
});
