jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      gift: {
         findUnique: jest.fn(),
         findMany: jest.fn(),
         create: jest.fn(),
         update: jest.fn(),
      },
      stellarWallet: { findUnique: jest.fn() },
   },
}));
jest.mock('../../clients/soroban.client', () => ({ getTransaction: jest.fn() }));

import express from 'express';
import request from 'supertest';
import { prisma } from '../../utils/prisma.utils';
import { signWalletAccessToken } from '../../utils/jwt.utils';
import { giftRouter } from './gift.routes';
import {
   GiftVerificationService,
   GiftVerificationError,
} from './gift-verification.service';
import { giftVerificationService } from './gift-verification.service';

const gift = prisma.gift as unknown as Record<string, jest.Mock>;
const A = 'GA5XIGA5C7GTGTW7ZKJ4YV6OEILUY2Q7YIHZQNNDJUWAVES4O7D5SUK9';
const B = 'GBRPYHAL2FCCNNGSJCJ2OOJ6MOL2RLUVTDMYNOOWGGVJXC7UE5ABSCJL';

const app = express();
app.use(express.json());
app.use('/', giftRouter);
app.use(
   (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
   ) => {
      res.status(500).json({ error: err.message });
   }
);

beforeEach(() => jest.resetAllMocks());

describe('GiftVerificationService', () => {
   const ev = { from: A, to: B, quantity: 2, keyId: 'K1' };
   it('succeeds on a matching transfer', async () => {
      const svc = new GiftVerificationService({
         getTransferEventsByTxHash: async () => [ev],
      });
      await expect(svc.verify('tx', A, B, 2, 'K1')).resolves.toEqual({
         keyId: 'K1',
         quantity: 2,
      });
   });
   it('throws MISMATCH on wrong recipient or quantity', async () => {
      const svc = new GiftVerificationService({
         getTransferEventsByTxHash: async () => [ev],
      });
      await expect(svc.verify('tx', A, A, 2)).rejects.toMatchObject({
         code: 'MISMATCH',
      });
      await expect(svc.verify('tx', A, B, 3)).rejects.toBeInstanceOf(
         GiftVerificationError
      );
   });
   it('throws NOT_FOUND when no events', async () => {
      const svc = new GiftVerificationService({
         getTransferEventsByTxHash: async () => [],
      });
      await expect(svc.verify('tx', A, B)).rejects.toMatchObject({
         code: 'NOT_FOUND',
      });
   });
});

describe('gift routes', () => {
   const body = {
      txHash: 'tx1',
      keyId: 'K1',
      quantity: 2,
      sender: A,
      recipient: B,
      message: 'hi',
   };

   it('POST /gifts 201 when verified', async () => {
      gift.findUnique.mockResolvedValue(null);
      jest.spyOn(giftVerificationService, 'verify').mockResolvedValue({
         keyId: 'K1',
         quantity: 2,
      });
      gift.create.mockResolvedValue({ id: 'g1', ...body });
      const res = await request(app).post('/gifts').send(body);
      expect(res.status).toBe(201);
   });

   it('POST /gifts 409 on duplicate txHash', async () => {
      gift.findUnique.mockResolvedValue({ id: 'g1' });
      const res = await request(app).post('/gifts').send(body);
      expect(res.status).toBe(409);
   });

   it('POST /gifts 400 when message exceeds 140 chars', async () => {
      const res = await request(app)
         .post('/gifts')
         .send({ ...body, message: 'x'.repeat(141) });
      expect(res.status).toBe(400);
   });

   it('POST /gifts 400 when on-chain transfer does not match', async () => {
      gift.findUnique.mockResolvedValue(null);
      jest
         .spyOn(giftVerificationService, 'verify')
         .mockRejectedValue(
            new GiftVerificationError('mismatch', 'MISMATCH')
         );
      const res = await request(app).post('/gifts').send(body);
      expect(res.status).toBe(400);
      expect(gift.create).not.toHaveBeenCalled();
   });

   it('GET wallet gifts requires auth and matching wallet', async () => {
      expect((await request(app).get(`/wallets/${B}/gifts`)).status).toBe(401);
      const tokA = signWalletAccessToken(A);
      expect(
         (
            await request(app)
               .get(`/wallets/${B}/gifts`)
               .set('Authorization', `Bearer ${tokA}`)
         ).status
      ).toBe(401);
   });

   it('GET unseen=true filters seenAt null', async () => {
      gift.findMany.mockResolvedValue([]);
      const tok = signWalletAccessToken(B);
      const res = await request(app)
         .get(`/wallets/${B}/gifts?unseen=true`)
         .set('Authorization', `Bearer ${tok}`);
      expect(res.status).toBe(200);
      expect(gift.findMany.mock.calls[0][0].where).toEqual({
         recipient: B,
         seenAt: null,
      });
   });

   it('POST seen: 401 without token, 403 for non-recipient, 200 for recipient', async () => {
      expect((await request(app).post('/gifts/g1/seen')).status).toBe(401);
      gift.findUnique.mockResolvedValue({ id: 'g1', recipient: B, seenAt: null });
      const other = await request(app)
         .post('/gifts/g1/seen')
         .set('Authorization', `Bearer ${signWalletAccessToken(A)}`);
      expect(other.status).toBe(403);
      gift.update.mockResolvedValue({ id: 'g1', recipient: B, seenAt: new Date() });
      const ok = await request(app)
         .post('/gifts/g1/seen')
         .set('Authorization', `Bearer ${signWalletAccessToken(B)}`);
      expect(ok.status).toBe(200);
   });
});
