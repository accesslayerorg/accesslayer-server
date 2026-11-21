import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import adminRouter from '../admin.routes';
import { prisma } from '../../../utils/prisma.utils';
import { errorHandler } from '../../../middlewares/error.middleware';

const app = express();
app.use(express.json());
app.use('/admin', adminRouter);
app.use(errorHandler);

const ADMIN_WALLET = 'GAADMINLOCKUPTESTWALLET111111111111111111111111';
const NON_ADMIN_WALLET = 'GANONADMINUSERWALLET22222222222222222222222222';

Object.assign(prisma as any, {
   timelockProposal: {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
   },
   governanceProposal: {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
   },
   auditLog: {
      create: jest.fn(),
   },
   activity: {
      create: jest.fn(),
      findMany: jest.fn(),
   },
});

describe('Admin Protocol Lockup Duration Endpoint (Issue #838) - POST /admin/protocol/lockup', () => {
   let adminToken: string;
   let nonAdminToken: string;

   beforeAll(() => {
      const secret =
         process.env.JWT_SECRET ||
         'accesslayer_default_development_jwt_secret_key_32_bytes';
      adminToken = jwt.sign({ sub: ADMIN_WALLET, role: 'admin' }, secret);
      nonAdminToken = jwt.sign({ sub: NON_ADMIN_WALLET, role: 'user' }, secret);
   });

   beforeEach(() => {
      jest.restoreAllMocks();
   });

   it('returns 403 when non-admin JWT is supplied', async () => {
      const res = await request(app)
         .post('/admin/protocol/lockup')
         .set('Authorization', `Bearer ${nonAdminToken}`)
         .send({ durationSeconds: 7200 });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
   });

   it('returns 422 when durationSeconds is below 3600 (1 hour)', async () => {
      const res = await request(app)
         .post('/admin/protocol/lockup')
         .set('Authorization', `Bearer ${adminToken}`)
         .send({ durationSeconds: 1800 }); // 30 minutes

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details).toEqual(
         expect.arrayContaining([
            expect.objectContaining({ field: 'durationSeconds' }),
         ])
      );
   });

   it('returns 422 when durationSeconds is above 604800 (7 days)', async () => {
      const res = await request(app)
         .post('/admin/protocol/lockup')
         .set('Authorization', `Bearer ${adminToken}`)
         .send({ durationSeconds: 1000000 });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details).toEqual(
         expect.arrayContaining([
            expect.objectContaining({ field: 'durationSeconds' }),
         ])
      );
   });

   it('creates timelock proposal in timelock_proposals and returns proposalId & executionNotBefore for valid input', async () => {
      const timelockCreateSpy = (
         jest.spyOn(prisma.timelockProposal, 'create') as any
      ).mockImplementation((args: any) => {
         return Promise.resolve({
            id: 'tl-db-123',
            proposalId: args.data.proposalId,
            changeType: args.data.changeType,
            payload: args.data.payload,
            executionNotBefore: args.data.executionNotBefore,
            status: 'pending',
            createdAt: new Date('2026-08-26T12:00:00.000Z'),
            executedAt: null,
         });
      });

      (
         jest.spyOn(prisma.governanceProposal, 'create') as any
      ).mockResolvedValue({});
      (jest.spyOn(prisma.auditLog, 'create') as any).mockResolvedValue({});
      (jest.spyOn(prisma.activity, 'create') as any).mockResolvedValue({});

      const validDuration = 86400; // 1 day
      const res = await request(app)
         .post('/admin/protocol/lockup')
         .set('Authorization', `Bearer ${adminToken}`)
         .send({ durationSeconds: validDuration });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.proposalId).toBeDefined();
      expect(res.body.data.proposalId).toMatch(/^tl-lockup-/);
      expect(res.body.data.changeType).toBe('update_lockup');
      expect(res.body.data.durationSeconds).toBe(validDuration);
      expect(res.body.data.executionNotBefore).toBeDefined();
      expect(res.body.data.status).toBe('pending');

      expect(timelockCreateSpy).toHaveBeenCalledWith(
         expect.objectContaining({
            data: expect.objectContaining({
               changeType: 'update_lockup',
               payload: { durationSeconds: validDuration },
               status: 'pending',
            }),
         })
      );
   });

   it('requires an admin JWT for the pending timelock actions endpoint', async () => {
      const res = await request(app)
         .get('/admin/timelock/pending')
         .set('Authorization', `Bearer ${nonAdminToken}`);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
   });

   it('returns pending timelock actions with execution timestamp and countdown metadata', async () => {
      const futureDate = new Date(Date.now() + 60 * 60 * 1000);
      const pendingActions = [
         {
            id: 'tl-pending-1',
            proposalId: 'tl-proposal-1',
            changeType: 'update_lockup',
            payload: { durationSeconds: 86400 },
            status: 'pending',
            executionNotBefore: futureDate,
            createdAt: new Date('2026-08-26T12:00:00.000Z'),
            executedAt: null,
         },
      ];

      jest.spyOn(prisma.timelockProposal, 'findMany').mockResolvedValue(
         pendingActions as any
      );

      const res = await request(app)
         .get('/admin/timelock/pending')
         .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.actions).toHaveLength(1);
      expect(res.body.data.actions[0]).toMatchObject({
         proposalId: 'tl-proposal-1',
         changeType: 'update_lockup',
         status: 'pending',
         eventType: 'ActionProposed',
         executionTimestamp: futureDate.toISOString(),
      });
      expect(res.body.data.actions[0].countdownMs).toEqual(
         expect.any(Number)
      );
      expect(res.body.data.actions[0].countdown).toEqual(expect.any(String));
      expect(res.body.data.nextExecutionTimestamp).toBe(futureDate.toISOString());
   });

   it('returns executed and cancelled timelock actions in the history view', async () => {
      const executedAt = new Date('2026-08-27T08:00:00.000Z');
      const cancelledAt = new Date('2026-08-26T12:00:00.000Z');

      jest.spyOn(prisma.timelockProposal, 'findMany').mockResolvedValue([
         {
            id: 'tl-executed-1',
            proposalId: 'tl-proposal-2',
            changeType: 'update_fee',
            payload: { feeBps: 100 },
            status: 'executed',
            executionNotBefore: new Date('2026-08-27T07:00:00.000Z'),
            createdAt: new Date('2026-08-26T11:00:00.000Z'),
            executedAt,
         },
         {
            id: 'tl-cancelled-1',
            proposalId: 'tl-proposal-3',
            changeType: 'update_protocol',
            payload: { enabled: false },
            status: 'cancelled',
            executionNotBefore: new Date('2026-08-27T07:00:00.000Z'),
            createdAt: new Date('2026-08-26T12:00:00.000Z'),
            executedAt: null,
         },
      ] as any);

      const res = await request(app)
         .get('/admin/timelock/history')
         .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.history).toHaveLength(2);
      expect(res.body.data.history).toEqual(
         expect.arrayContaining([
            expect.objectContaining({
               proposalId: 'tl-proposal-2',
               status: 'executed',
               eventType: 'ActionExecuted',
               executionTimestamp: executedAt.toISOString(),
            }),
            expect.objectContaining({
               proposalId: 'tl-proposal-3',
               status: 'cancelled',
               eventType: 'ActionCancelled',
               cancelledAt: cancelledAt.toISOString(),
            }),
         ])
      );
   });
});
