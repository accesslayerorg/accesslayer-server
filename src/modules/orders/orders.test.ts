import request from 'supertest';
import app from '../../app';
import { signWalletAccessToken } from '../../utils/jwt.utils';
import { prisma } from '../../utils/prisma.utils';

describe('POST /v1/orders', () => {
   const testWallet =
      'GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR';
   let validToken: string;

   beforeAll(() => {
      validToken = signWalletAccessToken(testWallet);
   });

   it('rejects unauthenticated order requests with 401', async () => {
      const res = await request(app)
         .post('/v1/orders')
         .send({ keyId: 'some-key', quantity: 1, side: 'buy' });

      expect(res.status).toBe(401);
   });

   it('rejects invalid order body with 400/422 validation error', async () => {
      const res = await request(app)
         .post('/v1/orders')
         .set('Authorization', `Bearer ${validToken}`)
         .send({ quantity: 'not-a-number' });

      expect(res.status).toBe(400);
   });

   it('returns 404 when keyId is not found', async () => {
      (prisma.creatorProfile.findFirst as jest.Mock).mockResolvedValueOnce(
         null
      );

      const res = await request(app)
         .post('/v1/orders')
         .set('Authorization', `Bearer ${validToken}`)
         .send({ keyId: 'non-existent-key', quantity: 1, side: 'buy' });

      expect(res.status).toBe(404);
   });

   it('successfully creates trade and ownership records when order is placed', async () => {
      const mockCreator = {
         id: 'seed-key-00000',
         handle: 'creator_seed_00000',
         circulatingSupply: '100',
      };
      (prisma.creatorProfile.findFirst as jest.Mock).mockResolvedValueOnce(
         mockCreator
      );
      (prisma.trade.create as jest.Mock).mockResolvedValueOnce({
         id: 'trade-test-123',
         buyer: testWallet,
         creatorId: mockCreator.id,
         quantity: '1',
         price: '1.5',
         ledger: 1000000,
         txHash: '0xtesthash123',
         timestamp: new Date(),
         createdAt: new Date(),
      });
      (prisma.keyOwnership.upsert as jest.Mock).mockResolvedValueOnce({
         ownerAddress: testWallet,
         creatorId: mockCreator.id,
         balance: '1',
      });
      (prisma.creatorProfile.update as jest.Mock).mockResolvedValueOnce({
         ...mockCreator,
         circulatingSupply: '101',
      });

      const res = await request(app)
         .post('/v1/orders')
         .set('Authorization', `Bearer ${validToken}`)
         .send({
            keyId: 'seed-key-00000',
            quantity: 1,
            side: 'buy',
            price: 1.5,
         });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.orderId).toBe('trade-test-123');
      expect(res.body.data.buyer).toBe(testWallet);
   });
});

describe('GET /v1/keys', () => {
   it('serves list of keys via /v1/keys', async () => {
      (prisma.creatorProfile.findMany as jest.Mock).mockResolvedValueOnce([]);
      (prisma.creatorProfile.count as jest.Mock).mockResolvedValueOnce(0);

      const res = await request(app).get('/v1/keys');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
   });
});
