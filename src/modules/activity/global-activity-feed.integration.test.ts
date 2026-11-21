// Integration test: global activity feed endpoint returning five most recent transactions (#741)
//
// Acceptance Criteria:
//   - Exactly five entries returned when more than five exist
//   - Entries are the five most recent by timestamp (newest first)
//   - All required fields present: wallet (truncated), action, creator_wallet, key_amount, created_at
//   - Endpoint accessible without authentication (HTTP 200)
//   - Empty array returned when no transactions exist

import supertest from 'supertest';
import app from '../../app';
import { prisma } from '../../utils/prisma.utils';

// ── Test Fixtures ─────────────────────────────────────────────────────────────

const CREATOR_WALLET_1 =
   'GCREATOR11111111111111111111111111111111111111111111111';
const CREATOR_WALLET_2 =
   'GCREATOR22222222222222222222222222222222222222222222222';
const CREATOR_WALLET_3 =
   'GCREATOR33333333333333333333333333333333333333333333333';

const ACTOR_WALLET_1 = 'GACTOR111111111111111111111111111111111111111111111111';
const ACTOR_WALLET_2 = 'GACTOR222222222222222222222222222222222222222222222222';
const ACTOR_WALLET_3 = 'GACTOR333333333333333333333333333333333333333333333333';

const TEST_USER_ID = 'global-activity-test-user';

// ── Test Suite ────────────────────────────────────────────────────────────────

describe('GET /api/v1/activity — global activity feed five most recent transactions (#741)', () => {
   let creatorId1: string;
   let creatorId2: string;
   let creatorId3: string;

   // Seven transactions seeded across three creators at distinct timestamps T1 < T2 < ... < T7
   const T1 = new Date('2026-08-17T10:00:00.000Z');
   const T2 = new Date('2026-08-17T11:00:00.000Z');
   const T3 = new Date('2026-08-17T12:00:00.000Z');
   const T4 = new Date('2026-08-17T13:00:00.000Z');
   const T5 = new Date('2026-08-17T14:00:00.000Z');
   const T6 = new Date('2026-08-17T15:00:00.000Z');
   const T7 = new Date('2026-08-17T16:00:00.000Z');

   beforeAll(async () => {
      const user = await prisma.user.create({
         data: {
            id: TEST_USER_ID,
            email: 'global-activity-test@example.com',
            passwordHash: 'dummy-hash',
            firstName: 'Global',
            lastName: 'Activity Test',
         },
      });

      const creator1 = await prisma.creatorProfile.create({
         data: {
            userId: user.id,
            handle: 'global-activity-creator-1',
            displayName: 'Global Activity Creator 1',
         },
      });
      creatorId1 = creator1.id;

      const creator2 = await prisma.creatorProfile.create({
         data: {
            userId: user.id,
            handle: 'global-activity-creator-2',
            displayName: 'Global Activity Creator 2',
         },
      });
      creatorId2 = creator2.id;

      const creator3 = await prisma.creatorProfile.create({
         data: {
            userId: user.id,
            handle: 'global-activity-creator-3',
            displayName: 'Global Activity Creator 3',
         },
      });
      creatorId3 = creator3.id;

      // Seed seven transactions across three creators at different timestamps
      await prisma.activity.create({
         data: {
            type: 'KEY_BOUGHT',
            actor: ACTOR_WALLET_1,
            creatorId: creatorId1,
            payload: {
               action: 'buy',
               wallet: ACTOR_WALLET_1,
               creator_wallet: CREATOR_WALLET_1,
               key_amount: 1,
               amount: 1,
               price_at_trade: '1000000',
            },
            createdAt: T1,
         },
      });

      await prisma.activity.create({
         data: {
            type: 'KEY_SOLD',
            actor: ACTOR_WALLET_2,
            creatorId: creatorId2,
            payload: {
               action: 'sell',
               wallet: ACTOR_WALLET_2,
               creator_wallet: CREATOR_WALLET_2,
               key_amount: 2,
               amount: 2,
               price_at_trade: '1200000',
            },
            createdAt: T2,
         },
      });

      await prisma.activity.create({
         data: {
            type: 'KEY_BOUGHT',
            actor: ACTOR_WALLET_3,
            creatorId: creatorId3,
            payload: {
               action: 'buy',
               wallet: ACTOR_WALLET_3,
               creator_wallet: CREATOR_WALLET_3,
               key_amount: 3,
               amount: 3,
               price_at_trade: '1500000',
            },
            createdAt: T3,
         },
      });

      await prisma.activity.create({
         data: {
            type: 'KEY_SOLD',
            actor: ACTOR_WALLET_1,
            creatorId: creatorId2,
            payload: {
               action: 'sell',
               wallet: ACTOR_WALLET_1,
               creator_wallet: CREATOR_WALLET_2,
               key_amount: 4,
               amount: 4,
               price_at_trade: '1800000',
            },
            createdAt: T4,
         },
      });

      await prisma.activity.create({
         data: {
            type: 'KEY_BOUGHT',
            actor: ACTOR_WALLET_2,
            creatorId: creatorId1,
            payload: {
               action: 'buy',
               wallet: ACTOR_WALLET_2,
               creator_wallet: CREATOR_WALLET_1,
               key_amount: 5,
               amount: 5,
               price_at_trade: '2000000',
            },
            createdAt: T5,
         },
      });

      await prisma.activity.create({
         data: {
            type: 'KEY_SOLD',
            actor: ACTOR_WALLET_3,
            creatorId: creatorId3,
            payload: {
               action: 'sell',
               wallet: ACTOR_WALLET_3,
               creator_wallet: CREATOR_WALLET_3,
               key_amount: 6,
               amount: 6,
               price_at_trade: '2200000',
            },
            createdAt: T6,
         },
      });

      await prisma.activity.create({
         data: {
            type: 'KEY_BOUGHT',
            actor: ACTOR_WALLET_1,
            creatorId: creatorId3,
            payload: {
               action: 'buy',
               wallet: ACTOR_WALLET_1,
               creator_wallet: CREATOR_WALLET_3,
               key_amount: 7,
               amount: 7,
               price_at_trade: '2500000',
            },
            createdAt: T7,
         },
      });
   });

   afterAll(async () => {
      await prisma.activity.deleteMany({
         where: {
            creatorId: { in: [creatorId1, creatorId2, creatorId3] },
         },
      });
      await prisma.creatorProfile.deleteMany({
         where: { id: { in: [creatorId1, creatorId2, creatorId3] } },
      });
      await prisma.user.delete({ where: { id: TEST_USER_ID } });
      await prisma.$disconnect();
   });

   it('accessible without authentication', async () => {
      const res = await supertest(app).get('/api/v1/activity?limit=5');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
   });

   it('returns exactly five entries when seven transactions exist', async () => {
      const res = await supertest(app).get('/api/v1/activity?limit=5');

      expect(res.status).toBe(200);
      expect(res.body.data.items).toHaveLength(5);
      expect(res.body.data.meta.total).toBe(7);
   });

   it('returns the five most recent transactions ordered newest first by timestamp', async () => {
      const res = await supertest(app).get('/api/v1/activity?limit=5');

      const items = res.body.data.items;
      expect(items).toHaveLength(5);

      // Assert timestamps are strictly descending (newest first)
      for (let i = 0; i < items.length - 1; i++) {
         const current = new Date(
            items[i].created_at || items[i].createdAt
         ).getTime();
         const next = new Date(
            items[i + 1].created_at || items[i + 1].createdAt
         ).getTime();
         expect(current).toBeGreaterThan(next);
      }

      // Verify the timestamps match the expected 5 most recent (T7, T6, T5, T4, T3)
      const timestamps = items.map((item: any) =>
         new Date(item.created_at || item.createdAt).toISOString()
      );
      expect(timestamps).toEqual([
         T7.toISOString(),
         T6.toISOString(),
         T5.toISOString(),
         T4.toISOString(),
         T3.toISOString(),
      ]);
   });

   it('includes required fields (wallet, action, creator_wallet, key_amount, created_at) in each entry', async () => {
      const res = await supertest(app).get('/api/v1/activity?limit=5');

      const items = res.body.data.items;
      expect(items).toHaveLength(5);

      for (const item of items) {
         expect(item.wallet).toBeDefined();
         expect(typeof item.wallet).toBe('string');
         expect(item.wallet).toContain('…');

         expect(item.action).toBeDefined();
         expect(['buy', 'sell', 'KEY_BOUGHT', 'KEY_SOLD']).toContain(
            item.action
         );

         expect(item.creator_wallet).toBeDefined();
         expect(typeof item.creator_wallet).toBe('string');

         expect(item.key_amount).toBeDefined();
         expect(typeof item.key_amount).toBe('number');
         expect(item.key_amount).toBeGreaterThan(0);

         expect(item.created_at || item.createdAt).toBeDefined();
         expect(
            new Date(item.created_at || item.createdAt).getTime()
         ).not.toBeNaN();
      }
   });

   it('returns an empty array when no transactions exist', async () => {
      await prisma.activity.deleteMany({
         where: {
            creatorId: { in: [creatorId1, creatorId2, creatorId3] },
         },
      });

      const res = await supertest(app).get('/api/v1/activity?limit=5');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.items).toEqual([]);
      expect(res.body.data.meta.total).toBe(0);
   });
});
