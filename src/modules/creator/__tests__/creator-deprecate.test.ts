const mockRedis = {
   lpush: jest.fn().mockResolvedValue(1),
};

jest.mock('../../../utils/redis.utils', () => ({
   getRedisClient: jest.fn(() => mockRedis),
   getRedis: jest.fn(() => mockRedis),
}));

jest.mock('../buy.service', () => ({
   buyGateway: {
      getXlmBalance: jest.fn(),
   },
}));

jest.mock('../creator-deprecate.service', () => ({
   deprecateGateway: {
      deprecateKey: jest.fn().mockResolvedValue({ transactionHash: 'mock-tx-hash' }),
   },
}));

jest.mock('../../../utils/prisma.utils', () => ({
   prisma: {
      creatorProfile: {
         findFirst: jest.fn(),
         update: jest.fn(),
      },
      stellarWallet: {
         findUnique: jest.fn(),
      },
      keyOwnership: {
         findMany: jest.fn(),
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

import request from 'supertest';
import express from 'express';
import creatorRouter from '../creator.routes';
import { prisma } from '../../../utils/prisma.utils';
import { signWalletAccessToken } from '../../../utils/jwt.utils';
import { buyGateway } from '../buy.service';
import { deprecateGateway } from '../creator-deprecate.service';

const app = express();
app.use(express.json());
app.use('/api/v1/creator', creatorRouter);

describe('Key Deprecation Endpoint (#872)', () => {
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

   it('returns 401 when no token is provided', async () => {
      const res = await request(app)
         .post(`/api/v1/creator/${keyId}/deprecate`)
         .send({ buybackPricePerKey: 5 });

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
         .post(`/api/v1/creator/${keyId}/deprecate`)
         .set('Authorization', `Bearer ${otherToken}`)
         .send({ buybackPricePerKey: 5 });

      expect(res.status).toBe(403);
   });

   it('returns 422 when buybackPricePerKey is 0', async () => {
      (prisma.creatorProfile.findFirst as jest.Mock).mockResolvedValue({
         id: keyId,
         handle: keyId,
         userId: creatorUserId,
      });
      (prisma.stellarWallet.findUnique as jest.Mock).mockResolvedValue({
         userId: creatorUserId,
      });

      const res = await request(app)
         .post(`/api/v1/creator/${keyId}/deprecate`)
         .set('Authorization', `Bearer ${creatorToken}`)
         .send({ buybackPricePerKey: 0 });

      expect(res.status).toBe(422);
      expect(res.body.error.message).toContain('greater than zero');
   });

   it('returns 422 when buybackPricePerKey is negative or non-integer', async () => {
      (prisma.creatorProfile.findFirst as jest.Mock).mockResolvedValue({
         id: keyId,
         handle: keyId,
         userId: creatorUserId,
      });
      (prisma.stellarWallet.findUnique as jest.Mock).mockResolvedValue({
         userId: creatorUserId,
      });

      const resNegative = await request(app)
         .post(`/api/v1/creator/${keyId}/deprecate`)
         .set('Authorization', `Bearer ${creatorToken}`)
         .send({ buybackPricePerKey: -5 });
      expect(resNegative.status).toBe(422);

      const resFloat = await request(app)
         .post(`/api/v1/creator/${keyId}/deprecate`)
         .set('Authorization', `Bearer ${creatorToken}`)
         .send({ buybackPricePerKey: 2.5 });
      expect(resFloat.status).toBe(422);

      const resString = await request(app)
         .post(`/api/v1/creator/${keyId}/deprecate`)
         .set('Authorization', `Bearer ${creatorToken}`)
         .send({ buybackPricePerKey: 'invalid' });
      expect(resString.status).toBe(422);
   });

   it('returns 400 when creator has insufficient XLM balance', async () => {
      (prisma.creatorProfile.findFirst as jest.Mock).mockResolvedValue({
         id: keyId,
         handle: keyId,
         userId: creatorUserId,
         circulatingSupply: 100,
      });
      (prisma.stellarWallet.findUnique as jest.Mock).mockResolvedValue({
         userId: creatorUserId,
      });
      // 100 * 5 = 500 XLM required, but creator only has 200 XLM
      (buyGateway.getXlmBalance as jest.Mock).mockResolvedValue(200);

      const res = await request(app)
         .post(`/api/v1/creator/${keyId}/deprecate`)
         .set('Authorization', `Bearer ${creatorToken}`)
         .send({ buybackPricePerKey: 5 });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('Insufficient creator XLM balance');
   });

   it('submits contract call, updates status to Deprecated, pauses trading, and enqueues holder notifications', async () => {
      (prisma.creatorProfile.findFirst as jest.Mock).mockResolvedValue({
         id: keyId,
         handle: keyId,
         userId: creatorUserId,
         circulatingSupply: 50,
      });
      (prisma.stellarWallet.findUnique as jest.Mock).mockResolvedValue({
         userId: creatorUserId,
      });
      // 50 * 2 = 100 XLM required, creator has 150 XLM
      (buyGateway.getXlmBalance as jest.Mock).mockResolvedValue(150);

      (prisma.creatorProfile.update as jest.Mock).mockResolvedValue({
         id: keyId,
         status: 'Deprecated',
         tradingPaused: true,
      });

      const holders = [
         { ownerAddress: 'GHOLDER1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', balance: 30 },
         { ownerAddress: 'GHOLDER2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', balance: 20 },
      ];
      (prisma.keyOwnership.findMany as jest.Mock).mockResolvedValue(holders);

      const res = await request(app)
         .post(`/api/v1/creator/${keyId}/deprecate`)
         .set('Authorization', `Bearer ${creatorToken}`)
         .send({ buybackPricePerKey: 2 });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.keyId).toBe(keyId);
      expect(res.body.data.status).toBe('Deprecated');
      expect(res.body.data.buybackPricePerKey).toBe(2);
      expect(res.body.data.circulatingSupply).toBe(50);
      expect(res.body.data.notifiedHoldersCount).toBe(2);

      expect(deprecateGateway.deprecateKey).toHaveBeenCalledWith({
         creatorId: keyId,
         buybackPricePerKey: 2,
         circulatingSupply: 50,
      });

      expect(prisma.creatorProfile.update).toHaveBeenCalledWith({
         where: { id: keyId },
         data: {
            status: 'Deprecated',
            tradingPaused: true,
         },
      });

      expect(prisma.activity.create).toHaveBeenCalledWith(
         expect.objectContaining({
            data: expect.objectContaining({
               type: 'KEY_DEPRECATED',
               creatorId: keyId,
            }),
         })
      );

      expect(mockRedis.lpush).toHaveBeenCalledTimes(2);
      expect(mockRedis.lpush).toHaveBeenCalledWith(
         'queue:notifications',
         expect.stringContaining('key_deprecated')
      );
   });
});
