// src/modules/creators/creator-public-profile.integration.test.ts
// Integration tests for creator public profile & deployed keys API (#1009).

import supertest from 'supertest';
import app from '../../app';
import { prisma } from '../../utils/prisma.utils';

describe('Creator Public Profile & Deployed Keys API (#1009)', () => {
   const walletAddress = 'G' + 'A'.repeat(55);
   const unregisteredWallet = 'G' + 'B'.repeat(55);
   const userId = 'user-public-profile-test';
   const creatorId1 = 'creator-profile-1';
   const creatorId2 = 'creator-profile-2';

   beforeAll(async () => {
      // Clean up test data
      await prisma.trade.deleteMany({ where: { creatorId: { in: [creatorId1, creatorId2] } } });
      await prisma.keyOwnership.deleteMany({ where: { creatorId: { in: [creatorId1, creatorId2] } } });
      await prisma.creatorProfile.deleteMany({ where: { id: { in: [creatorId1, creatorId2] } } });
      await prisma.stellarWallet.deleteMany({ where: { address: walletAddress } });
      await prisma.kycRecord.deleteMany({ where: { walletAddress } });
      await prisma.user.deleteMany({ where: { id: userId } });

      // Create user and wallet
      await prisma.user.create({
         data: {
            id: userId,
            email: 'publicprofile@example.test',
            passwordHash: 'hash',
            firstName: 'Public',
            lastName: 'Creator',
         },
      });

      await prisma.stellarWallet.create({
         data: {
            id: 'wallet-public-1',
            address: walletAddress,
            userId,
         },
      });

      // Create two deployed keys (creator profiles) in chronological order
      await prisma.creatorProfile.create({
         data: {
            id: creatorId1,
            userId,
            handle: 'creator_first',
            displayName: 'First Key Creator',
            isVerified: false,
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
         },
      });

      await prisma.creatorProfile.create({
         data: {
            id: creatorId2,
            userId,
            handle: 'creator_second',
            displayName: 'Second Key Creator',
            isVerified: false,
            createdAt: new Date('2026-01-02T00:00:00.000Z'),
         },
      });

      // Seed trade and ownership to test aggregate stats
      await prisma.keyOwnership.create({
         data: {
            id: 'ownership-1',
            creatorId: creatorId1,
            ownerAddress: 'GBHOLDER222222222222222222222222222222222222222222222222',
            balance: 10,
         },
      });

      await prisma.trade.create({
         data: {
            id: 'trade-1',
            creatorId: creatorId1,
            buyer: 'GBHOLDER222222222222222222222222222222222222222222222222',
            timestamp: new Date(),
            price: '1000000',
            quantity: '5',
            txHash: 'tx-hash-1',
            ledger: 100,
         },
      });
   });

   afterAll(async () => {
      await prisma.trade.deleteMany({ where: { creatorId: { in: [creatorId1, creatorId2] } } });
      await prisma.keyOwnership.deleteMany({ where: { creatorId: { in: [creatorId1, creatorId2] } } });
      await prisma.creatorProfile.deleteMany({ where: { id: { in: [creatorId1, creatorId2] } } });
      await prisma.stellarWallet.deleteMany({ where: { address: walletAddress } });
      await prisma.kycRecord.deleteMany({ where: { walletAddress } });
      await prisma.user.deleteMany({ where: { id: userId } });
   });

   it('returns 404 for unregistered wallets', async () => {
      const res = await supertest(app).get(`/api/v1/creators/${unregisteredWallet}`);
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
   });

   it('returns profile with member since, total keys, total volume, and cache headers', async () => {
      const res = await supertest(app).get(`/api/v1/creators/${walletAddress}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toMatchObject({
         wallet: walletAddress,
         totalKeys: 2,
         totalVolume: '5000000', // 1,000,000 * 5
      });
      expect(res.body.data.memberSince).toBeDefined();
      expect(res.headers['cache-control']).toContain('max-age=300');
   });

   it('derives verified flag correctly from KYC status', async () => {
      // Before KYC approval
      let res = await supertest(app).get(`/api/v1/creators/${walletAddress}`);
      expect(res.status).toBe(200);
      expect(res.body.data.isVerified).toBe(false);

      // Approve KYC
      await prisma.kycRecord.create({
         data: {
            walletAddress,
            status: 'APPROVED',
            approvedAt: new Date(),
         },
      });

      // After KYC approval
      res = await supertest(app).get(`/api/v1/creators/${walletAddress}`);
      expect(res.status).toBe(200);
      expect(res.body.data.isVerified).toBe(true);

      // Cleanup KYC for other tests
      await prisma.kycRecord.deleteMany({ where: { walletAddress } });
   });

   it('returns paginated deployed keys in deployment order (oldest first) with status and price', async () => {
      const res = await supertest(app).get(`/api/v1/creators/${walletAddress}/keys`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.items).toHaveLength(2);
      // Deployment order: creatorId1 (Jan 1) should come before creatorId2 (Jan 2)
      expect(res.body.data.items[0].id).toBe(creatorId1);
      expect(res.body.data.items[1].id).toBe(creatorId2);
      expect(res.body.data.items[0]).toHaveProperty('status');
      expect(res.body.data.items[0]).toHaveProperty('price');
      expect(res.headers['cache-control']).toContain('max-age=300');
   });
});
