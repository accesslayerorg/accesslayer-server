// Integration tests: referral tier endpoints (#1034)
//
// Exercises the full request lifecycle against the database for
//   GET /api/v1/referrals/tier?wallet=
//   GET /api/v1/referrals/tier/history?wallet=
// and verifies tier data is included in GET /api/v1/users/:wallet/referrals.

import request from 'supertest';
import { createServer } from '../../utils/server.utils';
import { prisma } from '../../utils/prisma.utils';
import { signWalletAccessToken } from '../../utils/jwt.utils';

const WALLET = 'G' + 'REFERRER'.padEnd(55, 'A');
const OTHER_WALLET = 'G' + 'OTHER'.padEnd(55, 'B');

describe('Referral tier endpoints (#1034)', () => {
   let app: any;
   let token: string;

   beforeAll(async () => {
      app = await createServer();
      token = signWalletAccessToken(WALLET);

      await prisma.referralTierEvent.deleteMany({
         where: { walletAddress: WALLET },
      });
      await prisma.referralTier.deleteMany({
         where: { walletAddress: WALLET },
      });

      await prisma.referralTier.create({
         data: {
            walletAddress: WALLET,
            tier: 2,
            cumulativeVolume: 1500,
            lastUpgradedAt: new Date('2026-09-02T00:00:00.000Z'),
         },
      });

      await prisma.referralTierEvent.createMany({
         data: [
            {
               walletAddress: WALLET,
               previousTier: 1,
               newTier: 2,
               cumulativeVolume: 1500,
               ledger: 100,
               txHash: 'tx-tier-upgrade-1034-1',
               eventIndex: 0,
               occurredAt: new Date('2026-09-02T00:00:00.000Z'),
            },
            {
               walletAddress: WALLET,
               previousTier: 2,
               newTier: 3,
               cumulativeVolume: 10000,
               ledger: 101,
               txHash: 'tx-tier-upgrade-1034-2',
               eventIndex: 0,
               occurredAt: new Date('2026-09-03T00:00:00.000Z'),
            },
         ],
         skipDuplicates: true,
      });
   });

   afterAll(async () => {
      await prisma.referralTierEvent.deleteMany({
         where: { walletAddress: WALLET },
      });
      await prisma.referralTier.deleteMany({
         where: { walletAddress: WALLET },
      });
   });

   describe('GET /api/v1/referrals/tier', () => {
      it('returns the current tier, volume, next threshold and reward rate', async () => {
         const res = await request(app)
            .get(`/api/v1/referrals/tier?wallet=${WALLET}`)
            .set('Authorization', `Bearer ${token}`);

         expect(res.status).toBe(200);
         expect(res.body.success).toBe(true);
         expect(res.body.data).toEqual({
            wallet: WALLET,
            tier: 2,
            cumulativeVolume: 1500,
            nextThreshold: 10000,
            distanceToNextThreshold: 8500,
            rewardRateBps: 750,
            updatedAt: '2026-09-02T00:00:00.000Z',
         });
      });

      it('rejects a request for a different wallet with 401', async () => {
         const res = await request(app)
            .get(`/api/v1/referrals/tier?wallet=${OTHER_WALLET}`)
            .set('Authorization', `Bearer ${token}`);

         expect(res.status).toBe(401);
      });

      it('requires authentication', async () => {
         const res = await request(app).get(
            `/api/v1/referrals/tier?wallet=${WALLET}`
         );

         expect(res.status).toBe(401);
      });
   });

   describe('GET /api/v1/referrals/tier/history', () => {
      it('returns the upgrade log newest first', async () => {
         const res = await request(app)
            .get(`/api/v1/referrals/tier/history?wallet=${WALLET}`)
            .set('Authorization', `Bearer ${token}`);

         expect(res.status).toBe(200);
         expect(res.body.data.items).toHaveLength(2);
         expect(res.body.data.items[0]).toEqual(
            expect.objectContaining({
               previousTier: 2,
               newTier: 3,
               cumulativeVolume: 10000,
               occurredAt: '2026-09-03T00:00:00.000Z',
            })
         );
      });

      it('paginates consistently with a cursor', async () => {
         const page1 = await request(app)
            .get(`/api/v1/referrals/tier/history?wallet=${WALLET}&limit=1`)
            .set('Authorization', `Bearer ${token}`);

         expect(page1.status).toBe(200);
         expect(page1.body.data.items).toHaveLength(1);
         expect(page1.body.data.pagination.hasMore).toBe(true);

         const cursor = page1.body.data.pagination.nextCursor;
         const page2 = await request(app)
            .get(
               `/api/v1/referrals/tier/history?wallet=${WALLET}&limit=1&cursor=${encodeURIComponent(
                  cursor
               )}`
            )
            .set('Authorization', `Bearer ${token}`);

         expect(page2.status).toBe(200);
         expect(page2.body.data.items).toHaveLength(1);
         expect(page2.body.data.items[0].id).not.toBe(
            page1.body.data.items[0].id
         );
      });
   });

   describe('GET /api/v1/users/:wallet/referrals', () => {
      it('includes tier data in the referral stats response', async () => {
         const res = await request(app)
            .get(`/api/v1/users/${WALLET}/referrals`)
            .set('Authorization', `Bearer ${token}`);

         expect(res.status).toBe(200);
         expect(res.body.data.tier).toEqual(
            expect.objectContaining({
               tier: 2,
               cumulativeVolume: 1500,
               rewardRateBps: 750,
            })
         );
      });
   });
});
