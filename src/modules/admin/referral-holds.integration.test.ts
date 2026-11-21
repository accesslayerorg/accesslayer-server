// HTTP tests for the admin referral hold endpoints (#1241). Prisma is mocked;
// routing, admin auth, validation and serialization run through the real app.

jest.mock('../../utils/prisma.utils', () => {
   const referralHold = {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
      findMany: jest.fn(),
   };
   const referralHoldReward = { findMany: jest.fn(), groupBy: jest.fn() };
   const referralEvent = { createMany: jest.fn() };
   return {
      prisma: {
         referralHold,
         referralHoldReward,
         referralEvent,
         auditLog: { create: jest.fn().mockResolvedValue({}) },
         $transaction: jest.fn((cb: (tx: unknown) => unknown) =>
            cb({ referralHold, referralHoldReward, referralEvent })
         ),
      },
   };
});

import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../app';
import { envConfig } from '../../config';
import { prisma } from '../../utils/prisma.utils';

// The first request boots the whole app, which is slow on a cold start.
jest.setTimeout(60_000);

const holdFindUnique = prisma.referralHold.findUnique as jest.Mock;
const holdUpdateMany = prisma.referralHold.updateMany as jest.Mock;
const holdFindMany = prisma.referralHold.findMany as jest.Mock;
const rewardFindMany = prisma.referralHoldReward.findMany as jest.Mock;
const rewardGroupBy = prisma.referralHoldReward.groupBy as jest.Mock;
const eventCreateMany = prisma.referralEvent.createMany as jest.Mock;
const auditCreate = prisma.auditLog.create as jest.Mock;

const adminToken = jwt.sign(
   { sub: 'admin-1', role: 'admin' },
   envConfig.JWT_SECRET
);
const userToken = jwt.sign(
   { sub: 'user-1', role: 'user' },
   envConfig.JWT_SECRET
);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

function holdRow(overrides: Record<string, unknown> = {}) {
   return {
      id: 'hold-1',
      referralId: 'ref-1',
      reason: 'FUNDING_CLUSTER',
      status: 'PENDING',
      details: { funder: 'GFUNDER' },
      referrerAddress: 'GREFERRER',
      refereeAddress: 'GREFEREE',
      resolvedBy: null,
      resolvedAt: null,
      createdAt: new Date('2026-11-05T12:00:01.000Z'),
      ...overrides,
   };
}

const withheld = {
   id: 'rw-1',
   holdId: 'hold-1',
   keyId: 'key-1',
   rewardXlm: 0.5,
   tierMultiplier: 1,
   txHash: 'tx-1',
   eventIndex: 0,
   tradedAt: new Date('2026-11-05T12:00:00.000Z'),
};

beforeEach(() => {
   jest.clearAllMocks();
   auditCreate.mockResolvedValue({});
   rewardFindMany.mockResolvedValue([withheld]);
   rewardGroupBy.mockResolvedValue([
      { holdId: 'hold-1', _sum: { rewardXlm: 0.5 }, _count: { _all: 1 } },
   ]);
   eventCreateMany.mockResolvedValue({ count: 1 });
});

describe('GET /api/v1/admin/referral-holds', () => {
   it('requires an admin token', async () => {
      await request(app).get('/api/v1/admin/referral-holds').expect(401);
      await request(app)
         .get('/api/v1/admin/referral-holds')
         .set(auth(userToken))
         .expect(403);
      expect(holdFindMany).not.toHaveBeenCalled();
   });

   it('lists holds and filters by status', async () => {
      holdFindMany.mockResolvedValue([holdRow()]);

      const res = await request(app)
         .get('/api/v1/admin/referral-holds')
         .query({ status: 'PENDING', limit: '10' })
         .set(auth(adminToken))
         .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.items[0]).toMatchObject({
         id: 'hold-1',
         status: 'PENDING',
         reason: 'FUNDING_CLUSTER',
         refereeAddress: 'GREFEREE',
         rewardXlm: 0.5,
         withheldTrades: 1,
      });
      expect(holdFindMany).toHaveBeenCalledWith(
         expect.objectContaining({ where: { status: 'PENDING' }, take: 11 })
      );
   });

   it.each([
      ['unknown status', { status: 'APPROVED' }],
      ['non-numeric limit', { limit: 'lots' }],
   ])('returns 400 for %s', async (_label, query) => {
      await request(app)
         .get('/api/v1/admin/referral-holds')
         .query(query)
         .set(auth(adminToken))
         .expect(400);
   });

   it('returns 400 for a malformed cursor', async () => {
      await request(app)
         .get('/api/v1/admin/referral-holds')
         .query({ cursor: 'garbage' })
         .set(auth(adminToken))
         .expect(400);
   });
});

describe('PATCH /api/v1/admin/referral-holds/:id', () => {
   function statefulHold() {
      let row = holdRow();
      holdFindUnique.mockImplementation(async () => ({ ...row }));
      holdUpdateMany.mockImplementation(
         async ({
            where,
            data,
         }: {
            where: { status: string };
            data: object;
         }) => {
            if (row.status !== where.status) return { count: 0 };
            row = { ...row, ...data };
            return { count: 1 };
         }
      );
   }

   it('requires an admin token', async () => {
      await request(app)
         .patch('/api/v1/admin/referral-holds/hold-1')
         .send({ status: 'RELEASED' })
         .expect(401);
      await request(app)
         .patch('/api/v1/admin/referral-holds/hold-1')
         .set(auth(userToken))
         .send({ status: 'RELEASED' })
         .expect(403);
      expect(eventCreateMany).not.toHaveBeenCalled();
   });

   it('release pays the reward once and writes an audit entry', async () => {
      statefulHold();

      const first = await request(app)
         .patch('/api/v1/admin/referral-holds/hold-1')
         .set(auth(adminToken))
         .send({ status: 'RELEASED' })
         .expect(200);

      expect(first.body.data).toMatchObject({
         id: 'hold-1',
         status: 'RELEASED',
         resolvedBy: 'admin-1',
      });
      expect(eventCreateMany).toHaveBeenCalledTimes(1);
      expect(auditCreate).toHaveBeenCalledWith({
         data: expect.objectContaining({
            actorWallet: 'admin-1',
            actionType: 'referral_hold_released',
            targetId: 'hold-1',
         }),
      });

      // Releasing again is a conflict and pays nothing more.
      await request(app)
         .patch('/api/v1/admin/referral-holds/hold-1')
         .set(auth(adminToken))
         .send({ status: 'RELEASED' })
         .expect(409);
      expect(eventCreateMany).toHaveBeenCalledTimes(1);
   });

   it('reject never pays', async () => {
      statefulHold();

      const res = await request(app)
         .patch('/api/v1/admin/referral-holds/hold-1')
         .set(auth(adminToken))
         .send({ status: 'REJECTED' })
         .expect(200);

      expect(res.body.data.status).toBe('REJECTED');
      expect(eventCreateMany).not.toHaveBeenCalled();
      expect(auditCreate).toHaveBeenCalledWith({
         data: expect.objectContaining({
            actionType: 'referral_hold_rejected',
         }),
      });
   });

   it('returns 404 for an unknown hold', async () => {
      holdFindUnique.mockResolvedValue(null);
      await request(app)
         .patch('/api/v1/admin/referral-holds/missing')
         .set(auth(adminToken))
         .send({ status: 'RELEASED' })
         .expect(404);
   });

   it('returns 409 for a hold that detection already rejected', async () => {
      holdFindUnique.mockResolvedValue(
         holdRow({ status: 'REJECTED', reason: 'SELF_REFERRAL' })
      );
      holdUpdateMany.mockResolvedValue({ count: 0 });
      await request(app)
         .patch('/api/v1/admin/referral-holds/hold-1')
         .set(auth(adminToken))
         .send({ status: 'RELEASED' })
         .expect(409);
      expect(eventCreateMany).not.toHaveBeenCalled();
   });

   it.each([
      ['PENDING (not a resolution)', { status: 'PENDING' }],
      ['unknown status', { status: 'APPROVED' }],
      ['missing status', {}],
      ['extra fields', { status: 'RELEASED', amount: 1000 }],
   ])('returns 400 for %s', async (_label, body) => {
      await request(app)
         .patch('/api/v1/admin/referral-holds/hold-1')
         .set(auth(adminToken))
         .send(body)
         .expect(400);
      expect(holdFindUnique).not.toHaveBeenCalled();
   });
});
