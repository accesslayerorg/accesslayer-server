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

const ADMIN_WALLET = 'GAADMINCIRCUITBREAKERTESTWALLET1111111111111111';
const NON_ADMIN_WALLET = 'GANONADMINCIRCUITTESTWALLET22222222222222222';
const KEY_ID = 'creator-circuit-key-101';

describe('Admin Key Circuit Breaker Endpoint (Issue #837) - POST /admin/keys/:keyId/circuit-breaker', () => {
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
         .post(`/admin/keys/${KEY_ID}/circuit-breaker`)
         .set('Authorization', `Bearer ${nonAdminToken}`)
         .send({ thresholdBps: 2500 });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
   });

   it('returns 422 when thresholdBps is below 100 (1%)', async () => {
      const res = await request(app)
         .post(`/admin/keys/${KEY_ID}/circuit-breaker`)
         .set('Authorization', `Bearer ${adminToken}`)
         .send({ thresholdBps: 50 });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details).toEqual(
         expect.arrayContaining([
            expect.objectContaining({ field: 'thresholdBps' }),
         ])
      );
   });

   it('returns 422 when thresholdBps is above 5000 (50%)', async () => {
      const res = await request(app)
         .post(`/admin/keys/${KEY_ID}/circuit-breaker`)
         .set('Authorization', `Bearer ${adminToken}`)
         .send({ thresholdBps: 6000 });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details).toEqual(
         expect.arrayContaining([
            expect.objectContaining({ field: 'thresholdBps' }),
         ])
      );
   });

   it('returns 404 when key ID does not exist', async () => {
      (jest.spyOn(prisma.creatorProfile, 'findFirst') as any).mockResolvedValue(
         null
      );

      const res = await request(app)
         .post(`/admin/keys/non-existent-key/circuit-breaker`)
         .set('Authorization', `Bearer ${adminToken}`)
         .send({ thresholdBps: 2000 });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
   });

   it('updates threshold in database, logs audit entry with old and new values, and returns 200', async () => {
      const existingCreator = {
         id: KEY_ID,
         handle: 'testcreator',
         circuitBreakerThreshold: 3000, // old value 30%
      };

      (jest.spyOn(prisma.creatorProfile, 'findFirst') as any).mockResolvedValue(
         existingCreator
      );

      const updateSpy = (
         jest.spyOn(prisma.creatorProfile, 'update') as any
      ).mockImplementation((args: any) => {
         return Promise.resolve({
            ...existingCreator,
            circuitBreakerThreshold: args.data.circuitBreakerThreshold,
         });
      });

      const auditLogSpy = (
         jest.spyOn(prisma.auditLog, 'create') as any
      ).mockResolvedValue({});
      const activitySpy = (
         jest.spyOn(prisma.activity, 'create') as any
      ).mockResolvedValue({});

      const newThreshold = 2500; // 25%
      const res = await request(app)
         .post(`/admin/keys/${KEY_ID}/circuit-breaker`)
         .set('Authorization', `Bearer ${adminToken}`)
         .send({ thresholdBps: newThreshold });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.keyId).toBe(KEY_ID);
      expect(res.body.data.circuitBreakerThreshold).toBe(newThreshold);
      expect(res.body.data.previousThresholdBps).toBe(3000);

      expect(updateSpy).toHaveBeenCalledWith(
         expect.objectContaining({
            where: { id: KEY_ID },
            data: { circuitBreakerThreshold: newThreshold },
         })
      );

      expect(auditLogSpy).toHaveBeenCalledWith(
         expect.objectContaining({
            data: expect.objectContaining({
               actorWallet: ADMIN_WALLET,
               actionType: 'CIRCUIT_BREAKER_THRESHOLD_UPDATED',
               targetId: KEY_ID,
               payload: {
                  keyId: KEY_ID,
                  oldThresholdBps: 3000,
                  newThresholdBps: newThreshold,
               },
            }),
         })
      );

      expect(activitySpy).toHaveBeenCalledWith(
         expect.objectContaining({
            data: expect.objectContaining({
               type: 'CIRCUIT_BREAKER_THRESHOLD_UPDATED',
               actor: ADMIN_WALLET,
               creatorId: KEY_ID,
               payload: {
                  keyId: KEY_ID,
                  previousThresholdBps: 3000,
                  newThresholdBps: newThreshold,
               },
            }),
         })
      );
   });
});
