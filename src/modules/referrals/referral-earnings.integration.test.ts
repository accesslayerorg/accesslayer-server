// Integration tests: referral earnings endpoints (#1057)
//
// Exercises the full request lifecycle against the database for
//   GET /api/v1/referrals/:wallet/earnings
//   GET /api/v1/referrals/:wallet/summary

import request from 'supertest';
import { createServer } from '../../utils/server.utils';
import { prisma } from '../../utils/prisma.utils';
import { signWalletAccessToken } from '../../utils/jwt.utils';

const WALLET = 'G' + 'REFERRER'.padEnd(55, 'A');
const SOURCE_A = 'G' + 'SOURCEA'.padEnd(55, 'B');
const SOURCE_B = 'G' + 'SOURCEB'.padEnd(55, 'C');

describe('Referral earnings endpoints (#1057)', () => {
   let app: any;
   let token: string;

   beforeAll(async () => {
      app = await createServer();
      token = signWalletAccessToken(WALLET);

      await prisma.referralEarning.deleteMany({
         where: { referrerWallet: WALLET },
      });

      await prisma.referralEarning.createMany({
         data: [
            {
               referrerWallet: WALLET,
               sourceWallet: SOURCE_A,
               tier: 1,
               amount: 10,
               txHash: 'tx-earn-1057-1',
               eventIndex: 0,
               ledger: 100,
               earnedAt: new Date('2026-08-10T00:00:00.000Z'),
            },
            {
               referrerWallet: WALLET,
               sourceWallet: SOURCE_A,
               tier: 2,
               amount: 4,
               txHash: 'tx-earn-1057-2',
               eventIndex: 0,
               ledger: 101,
               earnedAt: new Date('2026-08-12T00:00:00.000Z'),
            },
            {
               referrerWallet: WALLET,
               sourceWallet: SOURCE_B,
               tier: 3,
               amount: 6,
               txHash: 'tx-earn-1057-3',
               eventIndex: 0,
               ledger: 102,
               earnedAt: new Date('2026-08-15T00:00:00.000Z'),
            },
         ],
         skipDuplicates: true,
      });
   });

   afterAll(async () => {
      await prisma.referralEarning.deleteMany({
         where: { referrerWallet: WALLET },
      });
   });

   describe('GET /api/v1/referrals/:wallet/earnings', () => {
      it('returns earnings newest first with tier/amount/source/date', async () => {
         const res = await request(app)
            .get(`/api/v1/referrals/${WALLET}/earnings`)
            .set('Authorization', `Bearer ${token}`);

         expect(res.status).toBe(200);
         expect(res.body.success).toBe(true);
         expect(res.body.data.items).toHaveLength(3);

         const first = res.body.data.items[0];
         expect(first).toHaveProperty('tier');
         expect(first).toHaveProperty('amount');
         expect(first).toHaveProperty('sourceWallet');
         expect(first).toHaveProperty('earnedAt');
         expect(new Date(first.earnedAt).toISOString()).toBe(
            '2026-08-15T00:00:00.000Z'
         );
      });

      it('narrows results by an inclusive date range', async () => {
         const res = await request(app)
            .get(
               `/api/v1/referrals/${WALLET}/earnings?from=2026-08-11&to=2026-08-13`
            )
            .set('Authorization', `Bearer ${token}`);

         expect(res.status).toBe(200);
         expect(res.body.data.items).toHaveLength(1);
         expect(res.body.data.items[0].tier).toBe(2);
      });

      it('paginates consistently with a cursor', async () => {
         const page1 = await request(app)
            .get(`/api/v1/referrals/${WALLET}/earnings?limit=2`)
            .set('Authorization', `Bearer ${token}`);

         expect(page1.status).toBe(200);
         expect(page1.body.data.items).toHaveLength(2);
         expect(page1.body.data.pagination.hasMore).toBe(true);

         const cursor = page1.body.data.pagination.nextCursor;
         expect(cursor).toBeDefined();

         const page2 = await request(app)
            .get(
               `/api/v1/referrals/${WALLET}/earnings?limit=2&cursor=${encodeURIComponent(
                  cursor
               )}`
            )
            .set('Authorization', `Bearer ${token}`);

         expect(page2.status).toBe(200);
         expect(page2.body.data.items).toHaveLength(1);
         expect(page2.body.data.items[0].id).not.toBe(page1.body.data.items[0].id);
      });

      it('rejects an invalid cursor with 400', async () => {
         const res = await request(app)
            .get(`/api/v1/referrals/${WALLET}/earnings?cursor=tampered.cursor`)
            .set('Authorization', `Bearer ${token}`);

         expect(res.status).toBe(400);
      });

      it('rejects an invalid date range with 400', async () => {
         const res = await request(app)
            .get(
               `/api/v1/referrals/${WALLET}/earnings?from=2026-08-20&to=2026-08-01`
            )
            .set('Authorization', `Bearer ${token}`);

         expect(res.status).toBe(400);
      });

      it('rejects a request for a different wallet with 401', async () => {
         const res = await request(app)
            .get(`/api/v1/referrals/${SOURCE_B}/earnings`)
            .set('Authorization', `Bearer ${token}`);

         expect(res.status).toBe(401);
      });
   });

   describe('GET /api/v1/referrals/:wallet/summary', () => {
      it('returns totals, tier breakdown, and referred wallet count', async () => {
         const res = await request(app)
            .get(`/api/v1/referrals/${WALLET}/summary`)
            .set('Authorization', `Bearer ${token}`);

         expect(res.status).toBe(200);
         expect(res.body.data).toEqual({
            totalEarnings: 20,
            earningsCount: 3,
            referredWalletCount: 2,
            tiers: { tier1: 10, tier2: 4, tier3: 6 },
         });
      });

      it('requires authentication', async () => {
         const res = await request(app).get(
            `/api/v1/referrals/${WALLET}/summary`
         );

         expect(res.status).toBe(401);
      });
   });
});
