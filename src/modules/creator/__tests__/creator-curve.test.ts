jest.mock('../../../utils/prisma.utils', () => ({
   prisma: {
      creatorProfile: {
         findFirst: jest.fn(),
         update: jest.fn(),
      },
      stellarWallet: {
         findUnique: jest.fn(),
      },
      activity: {
         create: jest.fn(),
      },
   },
}));

jest.mock('../../../utils/logger.utils', () => ({
   logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
   },
}));

jest.mock('../creator-curve.service', () => ({
   curveGateway: {
      configureGraduatedCurve: jest.fn().mockResolvedValue({ transactionHash: 'mock-tx-hash' }),
   },
}));

import request from 'supertest';
import express from 'express';
import creatorRouter from '../creator.routes';
import keysRouter from '../../keys/keys.routes';
import { prisma } from '../../../utils/prisma.utils';
import { signWalletAccessToken } from '../../../utils/jwt.utils';
import { curveGateway } from '../creator-curve.service';

const app = express();
app.use(express.json());
app.use('/api/v1/creator', creatorRouter);
app.use('/api/v1/keys', keysRouter);

describe('Graduated Curve Configuration (#869)', () => {
   const creatorWallet = 'GCREATORWALLETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
   const otherWallet = 'GOTHERWALLETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
   const creatorUserId = 'user-creator-1';
   const otherUserId = 'user-other-2';
   const keyId = 'creator-1';

   let creatorToken: string;
   let otherToken: string;

   beforeAll(() => {
      creatorToken = signWalletAccessToken(creatorWallet);
      otherToken = signWalletAccessToken(otherWallet);
   });

   beforeEach(() => {
      jest.clearAllMocks();
   });

   describe('POST /api/v1/creator/:keyId/curve', () => {
      it('returns 401 when no token is provided', async () => {
         const res = await request(app)
            .post(`/api/v1/creator/${keyId}/curve`)
            .send({ milestones: [{ supplyThreshold: 10, exponent: 2 }] });

         expect(res.status).toBe(401);
      });

      it('returns 403 when caller is not the creator of the key', async () => {
         (prisma.creatorProfile.findFirst as jest.Mock).mockResolvedValue({
            id: keyId,
            handle: keyId,
            userId: creatorUserId,
         });
         (prisma.stellarWallet.findUnique as jest.Mock).mockResolvedValue({
            userId: otherUserId,
         });

         const res = await request(app)
            .post(`/api/v1/creator/${keyId}/curve`)
            .set('Authorization', `Bearer ${otherToken}`)
            .send({ milestones: [{ supplyThreshold: 10, exponent: 2 }] });

         expect(res.status).toBe(403);
      });

      it('returns 422 when more than 5 milestones are provided', async () => {
         (prisma.creatorProfile.findFirst as jest.Mock).mockResolvedValue({
            id: keyId,
            handle: keyId,
            userId: creatorUserId,
         });
         (prisma.stellarWallet.findUnique as jest.Mock).mockResolvedValue({
            userId: creatorUserId,
         });

         const res = await request(app)
            .post(`/api/v1/creator/${keyId}/curve`)
            .set('Authorization', `Bearer ${creatorToken}`)
            .send({
               milestones: [
                  { supplyThreshold: 10, exponent: 2 },
                  { supplyThreshold: 20, exponent: 2 },
                  { supplyThreshold: 30, exponent: 3 },
                  { supplyThreshold: 40, exponent: 3 },
                  { supplyThreshold: 50, exponent: 4 },
                  { supplyThreshold: 60, exponent: 5 },
               ],
            });

         expect(res.status).toBe(422);
      });

      it('returns 422 when thresholds are out of order', async () => {
         (prisma.creatorProfile.findFirst as jest.Mock).mockResolvedValue({
            id: keyId,
            handle: keyId,
            userId: creatorUserId,
         });
         (prisma.stellarWallet.findUnique as jest.Mock).mockResolvedValue({
            userId: creatorUserId,
         });

         const res = await request(app)
            .post(`/api/v1/creator/${keyId}/curve`)
            .set('Authorization', `Bearer ${creatorToken}`)
            .send({
               milestones: [
                  { supplyThreshold: 20, exponent: 2 },
                  { supplyThreshold: 10, exponent: 3 },
               ],
            });

         expect(res.status).toBe(422);
      });

      it('returns 422 when exponent is outside 1–5 or fractional', async () => {
         (prisma.creatorProfile.findFirst as jest.Mock).mockResolvedValue({
            id: keyId,
            handle: keyId,
            userId: creatorUserId,
         });
         (prisma.stellarWallet.findUnique as jest.Mock).mockResolvedValue({
            userId: creatorUserId,
         });

         const res0 = await request(app)
            .post(`/api/v1/creator/${keyId}/curve`)
            .set('Authorization', `Bearer ${creatorToken}`)
            .send({ milestones: [{ supplyThreshold: 10, exponent: 0 }] });
         expect(res0.status).toBe(422);

         const res6 = await request(app)
            .post(`/api/v1/creator/${keyId}/curve`)
            .set('Authorization', `Bearer ${creatorToken}`)
            .send({ milestones: [{ supplyThreshold: 10, exponent: 6 }] });
         expect(res6.status).toBe(422);

         const resFractional = await request(app)
            .post(`/api/v1/creator/${keyId}/curve`)
            .set('Authorization', `Bearer ${creatorToken}`)
            .send({ milestones: [{ supplyThreshold: 10, exponent: 1.5 }] });
         expect(resFractional.status).toBe(422);
      });

      it('submits contract call, stores milestones, records activity, and returns 200 for valid input', async () => {
         const validMilestones = [
            { supplyThreshold: 10, exponent: 2 },
            { supplyThreshold: 50, exponent: 3 },
            { supplyThreshold: 100, exponent: 4 },
         ];

         (prisma.creatorProfile.findFirst as jest.Mock).mockResolvedValue({
            id: keyId,
            handle: keyId,
            userId: creatorUserId,
            baseExponent: 1,
         });
         (prisma.stellarWallet.findUnique as jest.Mock).mockResolvedValue({
            userId: creatorUserId,
         });
         (prisma.creatorProfile.update as jest.Mock).mockResolvedValue({
            id: keyId,
            curveMilestones: validMilestones,
            baseExponent: 1,
         });

         const res = await request(app)
            .post(`/api/v1/creator/${keyId}/curve`)
            .set('Authorization', `Bearer ${creatorToken}`)
            .send({ milestones: validMilestones });

         expect(res.status).toBe(200);
         expect(res.body.success).toBe(true);
         expect(res.body.data.keyId).toBe(keyId);
         expect(res.body.data.milestones).toEqual(validMilestones);
         expect(res.body.data.baseExponent).toBe(1);

         expect(curveGateway.configureGraduatedCurve).toHaveBeenCalledWith({
            creatorId: keyId,
            milestones: validMilestones,
         });
         expect(prisma.creatorProfile.update).toHaveBeenCalledWith({
            where: { id: keyId },
            data: { curveMilestones: validMilestones },
         });
         expect(prisma.activity.create).toHaveBeenCalled();
      });
   });

   describe('GET /api/v1/keys/:keyId/curve-config', () => {
      it('returns 404 when key is not found', async () => {
         (prisma.creatorProfile.findFirst as jest.Mock).mockResolvedValue(null);

         const res = await request(app).get(`/api/v1/keys/nonexistent/curve-config`);
         expect(res.status).toBe(404);
      });

      it('returns milestones and base exponent without authentication', async () => {
         const storedMilestones = [
            { supplyThreshold: 25, exponent: 2 },
            { supplyThreshold: 75, exponent: 4 },
         ];

         (prisma.creatorProfile.findFirst as jest.Mock).mockResolvedValue({
            id: keyId,
            curveMilestones: storedMilestones,
            baseExponent: 1,
         });

         const res = await request(app).get(`/api/v1/keys/${keyId}/curve-config`);
         expect(res.status).toBe(200);
         expect(res.body.success).toBe(true);
         expect(res.body.data.keyId).toBe(keyId);
         expect(res.body.data.milestones).toEqual(storedMilestones);
         expect(res.body.data.baseExponent).toBe(1);
      });
   });
});
