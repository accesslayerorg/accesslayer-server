import express from 'express';
import request from 'supertest';

const mockSubscribe = jest.fn();
const mockUnsubscribe = jest.fn();
const mockGetVapidConfig = jest.fn();

jest.mock('./push.service', () => ({
   PushService: {
      subscribe: (...args: any[]) => mockSubscribe(...args),
      unsubscribe: (...args: any[]) => mockUnsubscribe(...args),
   },
   getVapidConfig: () => mockGetVapidConfig(),
}));

jest.mock('../../middlewares/jwt-auth.middleware', () => ({
   requireJwtAuth: (req: any, _res: any, next: any) => {
      req.user = { wallet: 'GWALLET_PUSH' };
      next();
   },
}));

import pushRouter from './push.routes';

const app = express();
app.use(express.json());
app.use('/v1/push', pushRouter);

describe('Push routes (#1314)', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('returns VAPID public key when configured', async () => {
      mockGetVapidConfig.mockReturnValue({
         publicKey: 'BPubKey123',
         privateKey: 'PrivKey',
         subject: 'mailto:test@accesslayer.org',
      });

      const res = await request(app).get('/v1/push/vapid-public-key');
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ publicKey: 'BPubKey123' });
   });

   it('creates and deletes push subscriptions', async () => {
      mockSubscribe.mockResolvedValue({ id: 'sub-1', wallet: 'GWALLET_PUSH' });
      const subRes = await request(app)
         .post('/v1/push/subscribe')
         .send({
            endpoint: 'https://push.example/sub1',
            keys: { p256dh: 'p256dh', auth: 'auth' },
            events: ['order.executable', 'price.alert'],
         });
      expect(subRes.status).toBe(201);
      expect(mockSubscribe).toHaveBeenCalledWith('GWALLET_PUSH', {
         endpoint: 'https://push.example/sub1',
         keys: { p256dh: 'p256dh', auth: 'auth' },
         events: ['order.executable', 'price.alert'],
      });

      mockUnsubscribe.mockResolvedValue(true);
      const delRes = await request(app)
         .delete('/v1/push/subscribe')
         .send({ endpoint: 'https://push.example/sub1' });
      expect(delRes.status).toBe(200);
   });
});
