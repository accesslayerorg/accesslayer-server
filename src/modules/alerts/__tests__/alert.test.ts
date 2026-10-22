import express from 'express';
import request from 'supertest';
import alertsRouter from '../alert.router';
import { prisma } from '../../../utils/prisma.utils';
import { signWalletAccessToken } from '../../../utils/jwt.utils';

jest.mock('../../../utils/prisma.utils', () => ({
   prisma: {
      priceAlert: {
         create: jest.fn(),
         findMany: jest.fn(),
         findFirst: jest.fn(),
         update: jest.fn(),
         delete: jest.fn(),
      },
   },
}));

jest.mock('../../../utils/logger.utils', () => ({
   logger: {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
   },
}));

const mockedPrisma = prisma as jest.Mocked<typeof prisma>;

const WALLET_A = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const WALLET_B = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

const app = express();
app.use(express.json());
app.use('/api/v1/alerts', alertsRouter);

describe('Price Alerts Endpoints (#867)', () => {
   let tokenA: string;
   let tokenB: string;

   beforeAll(() => {
      tokenA = signWalletAccessToken(WALLET_A);
      tokenB = signWalletAccessToken(WALLET_B);
   });

   afterEach(() => {
      jest.clearAllMocks();
   });

   describe('POST /api/v1/alerts', () => {
      it('returns 401 when no authorization header is sent', async () => {
         const res = await request(app)
            .post('/api/v1/alerts')
            .send({
               keyId: 'creator-1',
               targetPrice: 100,
               direction: 'above',
            });

         expect(res.status).toBe(401);
         expect(res.body.success).toBe(false);
         expect(mockedPrisma.priceAlert.create).not.toHaveBeenCalled();
      });

      it('creates an alert for the authenticated wallet', async () => {
         const mockCreated = {
            id: 'alert-1',
            creatorId: 'creator-1',
            walletAddress: WALLET_A,
            targetPrice: 100,
            direction: 'above',
            callbackUrl: 'https://accesslayer.org/webhooks/alerts',
            isActive: true,
            triggeredAt: null,
            createdAt: new Date(),
         };
         (mockedPrisma.priceAlert.findFirst as jest.Mock).mockResolvedValue(null);
         (mockedPrisma.priceAlert.create as jest.Mock).mockResolvedValue(mockCreated);

         const res = await request(app)
            .post('/api/v1/alerts')
            .set('Authorization', `Bearer ${tokenA}`)
            .send({
               keyId: 'creator-1',
               targetPrice: 100,
               direction: 'above',
            });

         expect(res.status).toBe(201);
         expect(res.body.success).toBe(true);
         expect(res.body.data.id).toBe('alert-1');
         expect(mockedPrisma.priceAlert.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
               creatorId: 'creator-1',
               walletAddress: WALLET_A,
               targetPrice: 100,
               direction: 'above',
            }),
         });
      });

      it('returns 400 when targetPrice is not positive', async () => {
         const res = await request(app)
            .post('/api/v1/alerts')
            .set('Authorization', `Bearer ${tokenA}`)
            .send({
               keyId: 'creator-1',
               targetPrice: -10,
               direction: 'above',
            });

         expect(res.status).toBe(400);
         expect(mockedPrisma.priceAlert.create).not.toHaveBeenCalled();
      });

      it('returns 400 when direction is invalid', async () => {
         const res = await request(app)
            .post('/api/v1/alerts')
            .set('Authorization', `Bearer ${tokenA}`)
            .send({
               keyId: 'creator-1',
               targetPrice: 100,
               direction: 'sideways',
            });

         expect(res.status).toBe(400);
         expect(mockedPrisma.priceAlert.create).not.toHaveBeenCalled();
      });

      it('returns 409 when identical active alert already exists', async () => {
         (mockedPrisma.priceAlert.findFirst as jest.Mock).mockResolvedValue({
            id: 'existing-alert',
         });

         const res = await request(app)
            .post('/api/v1/alerts')
            .set('Authorization', `Bearer ${tokenA}`)
            .send({
               keyId: 'creator-1',
               targetPrice: 100,
               direction: 'above',
            });

         expect(res.status).toBe(409);
         expect(mockedPrisma.priceAlert.create).not.toHaveBeenCalled();
      });
   });

   describe('GET /api/v1/alerts', () => {
      it('returns 401 when unauthenticated', async () => {
         const res = await request(app).get('/api/v1/alerts');
         expect(res.status).toBe(401);
      });

      it('returns active alerts for caller wallet', async () => {
         const alerts = [
            {
               id: 'alert-1',
               creatorId: 'creator-1',
               walletAddress: WALLET_A,
               targetPrice: 100,
               direction: 'above',
               isActive: true,
            },
         ];
         (mockedPrisma.priceAlert.findMany as jest.Mock).mockResolvedValue(alerts);

         const res = await request(app)
            .get('/api/v1/alerts')
            .set('Authorization', `Bearer ${tokenA}`);

         expect(res.status).toBe(200);
         expect(res.body.success).toBe(true);
         expect(res.body.data.items).toHaveLength(1);
         expect(mockedPrisma.priceAlert.findMany).toHaveBeenCalledWith({
            where: { walletAddress: WALLET_A, isActive: true },
            orderBy: { createdAt: 'desc' },
         });
      });
   });

   describe('PATCH /api/v1/alerts/:alertId/triggered', () => {
      it('returns 401 when unauthenticated', async () => {
         const res = await request(app).patch('/api/v1/alerts/alert-1/triggered');
         expect(res.status).toBe(401);
      });

      it('returns 404 when alert does not exist', async () => {
         (mockedPrisma.priceAlert.findFirst as jest.Mock).mockResolvedValue(null);

         const res = await request(app)
            .patch('/api/v1/alerts/nonexistent/triggered')
            .set('Authorization', `Bearer ${tokenA}`);

         expect(res.status).toBe(404);
      });

      it('returns 403 when caller is not the owner of the alert', async () => {
         (mockedPrisma.priceAlert.findFirst as jest.Mock).mockResolvedValue({
            id: 'alert-1',
            walletAddress: WALLET_A, // Owned by WALLET_A
            isActive: true,
         });

         // WALLET_B attempts to trigger WALLET_A's alert
         const res = await request(app)
            .patch('/api/v1/alerts/alert-1/triggered')
            .set('Authorization', `Bearer ${tokenB}`);

         expect(res.status).toBe(403);
         expect(mockedPrisma.priceAlert.update).not.toHaveBeenCalled();
      });

      it('successfully marks alert as triggered when caller is owner', async () => {
         (mockedPrisma.priceAlert.findFirst as jest.Mock).mockResolvedValue({
            id: 'alert-1',
            walletAddress: WALLET_A,
            isActive: true,
         });
         (mockedPrisma.priceAlert.update as jest.Mock).mockResolvedValue({
            id: 'alert-1',
            walletAddress: WALLET_A,
            isActive: false,
            triggeredAt: new Date(),
         });

         const res = await request(app)
            .patch('/api/v1/alerts/alert-1/triggered')
            .set('Authorization', `Bearer ${tokenA}`);

         expect(res.status).toBe(200);
         expect(res.body.success).toBe(true);
         expect(mockedPrisma.priceAlert.update).toHaveBeenCalledWith({
            where: { id: 'alert-1' },
            data: expect.objectContaining({
               isActive: false,
               triggeredAt: expect.any(Date),
            }),
         });
      });
   });

   describe('DELETE /api/v1/alerts/:alertId', () => {
      it('returns 401 when unauthenticated', async () => {
         const res = await request(app).delete('/api/v1/alerts/alert-1');
         expect(res.status).toBe(401);
      });

      it('returns 404 when alert does not exist', async () => {
         (mockedPrisma.priceAlert.findFirst as jest.Mock).mockResolvedValue(null);

         const res = await request(app)
            .delete('/api/v1/alerts/nonexistent')
            .set('Authorization', `Bearer ${tokenA}`);

         expect(res.status).toBe(404);
      });

      it('returns 403 when caller is not the owner of the alert', async () => {
         (mockedPrisma.priceAlert.findFirst as jest.Mock).mockResolvedValue({
            id: 'alert-1',
            walletAddress: WALLET_A, // Owned by WALLET_A
         });

         // WALLET_B attempts to delete WALLET_A's alert
         const res = await request(app)
            .delete('/api/v1/alerts/alert-1')
            .set('Authorization', `Bearer ${tokenB}`);

         expect(res.status).toBe(403);
         expect(mockedPrisma.priceAlert.delete).not.toHaveBeenCalled();
      });

      it('successfully deletes alert when caller is owner', async () => {
         (mockedPrisma.priceAlert.findFirst as jest.Mock).mockResolvedValue({
            id: 'alert-1',
            walletAddress: WALLET_A,
         });
         (mockedPrisma.priceAlert.delete as jest.Mock).mockResolvedValue({
            id: 'alert-1',
         });

         const res = await request(app)
            .delete('/api/v1/alerts/alert-1')
            .set('Authorization', `Bearer ${tokenA}`);

         expect(res.status).toBe(200);
         expect(res.body.success).toBe(true);
         expect(res.body.data).toEqual({ id: 'alert-1' });
         expect(mockedPrisma.priceAlert.delete).toHaveBeenCalledWith({
            where: { id: 'alert-1' },
         });
      });
   });
});
