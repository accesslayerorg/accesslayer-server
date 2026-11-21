jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      follow: {
         findUnique: jest.fn(),
         create: jest.fn(),
         delete: jest.fn(),
      },
      creatorProfile: {
         findUnique: jest.fn(),
         update: jest.fn(),
      },
      $transaction: jest.fn(),
   },
}));

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
      isLevelEnabled: jest.fn().mockReturnValue(false),
   },
}));

jest.mock('../../config', () => ({
   envConfig: {
      MODE: 'test',
      PORT: 3000,
      ENABLE_REQUEST_LOGGING: false,
   },
   appConfig: { allowedOrigins: [] },
}));

jest.mock('../../utils/wallet-ownership.utils', () => ({
   checkCreatorProfileOwnership: jest.fn(),
}));

jest.mock('../../middlewares/stellar-signature.middleware', () => ({
   requireStellarSignature:
      () => (req: any, _res: any, next: any) => {
         req.walletAddress =
            req.headers['x-wallet-address'] ||
            req.headers['wallet-address'];
         req.signatureVerified = true;
         next();
      },
}));

jest.mock('./creator-profile.service', () => ({
   getCreatorProfile: jest.fn(),
   upsertCreatorProfile: jest.fn(),
   creatorProfileExists: jest.fn(),
}));

import supertest from 'supertest';
import app from '../../app';
import { prisma } from '../../utils/prisma.utils';
import { creatorProfileExists } from './creator-profile.service';

const mockedPrisma = prisma as unknown as {
   follow: { findUnique: jest.Mock; create: jest.Mock; delete: jest.Mock };
   creatorProfile: { findUnique: jest.Mock; update: jest.Mock };
   $transaction: jest.Mock;
};
const mockedCreatorProfileExists =
   creatorProfileExists as jest.MockedFunction<typeof creatorProfileExists>;

const CREATOR_ID = 'test-creator-follow-1';
const FOLLOWER_ADDRESS = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

describe('POST/DELETE /api/v1/creators/:creatorId/follow — follower count', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      mockedCreatorProfileExists.mockResolvedValue(true);
   });

   it('increments follower count by 1 on follow', async () => {
      mockedPrisma.follow.findUnique.mockResolvedValue(null);
      mockedPrisma.$transaction.mockImplementation(async (fn: any) => {
         const tx = {
            follow: {
               create: jest.fn().mockResolvedValue({
                  id: 'follow-1',
                  followerAddress: FOLLOWER_ADDRESS,
                  creatorId: CREATOR_ID,
                  createdAt: new Date(),
               }),
            },
            creatorProfile: {
               update: jest.fn().mockResolvedValue({
                  id: CREATOR_ID,
                  followersCount: 1,
               }),
            },
         };
         await fn(tx);
         return tx.creatorProfile.update.mock.results[0].value;
      });

      const res = await supertest(app)
         .post(`/api/v1/creators/${CREATOR_ID}/follow`)
         .set('x-wallet-address', FOLLOWER_ADDRESS);

      expect(res.status).toBe(201);
      expect(res.body).toEqual(
         expect.objectContaining({
            success: true,
            data: expect.objectContaining({
               action: 'followed',
               followersCount: 1,
            }),
         })
      );
   });

   it('does not increment count on double follow (idempotent)', async () => {
      mockedPrisma.follow.findUnique.mockResolvedValue({
         id: 'existing-follow',
         followerAddress: FOLLOWER_ADDRESS,
         creatorId: CREATOR_ID,
         createdAt: new Date(),
      });
      mockedPrisma.creatorProfile.findUnique.mockResolvedValue({
         id: CREATOR_ID,
         followersCount: 1,
      } as any);

      const res = await supertest(app)
         .post(`/api/v1/creators/${CREATOR_ID}/follow`)
         .set('x-wallet-address', FOLLOWER_ADDRESS);

      expect(res.status).toBe(200);
      expect(res.body).toEqual(
         expect.objectContaining({
            success: true,
            data: expect.objectContaining({
               action: 'already_following',
               followersCount: 1,
            }),
         })
      );
   });

   it('decrements follower count by 1 on unfollow', async () => {
      mockedPrisma.follow.findUnique.mockResolvedValue({
         id: 'existing-follow',
         followerAddress: FOLLOWER_ADDRESS,
         creatorId: CREATOR_ID,
         createdAt: new Date(),
      });
      mockedPrisma.$transaction.mockImplementation(async (fn: any) => {
         const tx = {
            follow: {
               delete: jest.fn().mockResolvedValue({}),
            },
            creatorProfile: {
               update: jest.fn().mockResolvedValue({
                  id: CREATOR_ID,
                  followersCount: 0,
               }),
            },
         };
         await fn(tx);
         return tx.creatorProfile.update.mock.results[0].value;
      });

      const res = await supertest(app)
         .delete(`/api/v1/creators/${CREATOR_ID}/follow`)
         .set('x-wallet-address', FOLLOWER_ADDRESS);

      expect(res.status).toBe(200);
      expect(res.body).toEqual(
         expect.objectContaining({
            success: true,
            data: expect.objectContaining({
               action: 'unfollowed',
               followersCount: 0,
            }),
         })
      );
   });

   it('does not decrement count below 0 on double unfollow (idempotent)', async () => {
      mockedPrisma.follow.findUnique.mockResolvedValue(null);
      mockedPrisma.creatorProfile.findUnique.mockResolvedValue({
         id: CREATOR_ID,
         followersCount: 0,
      } as any);

      const res = await supertest(app)
         .delete(`/api/v1/creators/${CREATOR_ID}/follow`)
         .set('x-wallet-address', FOLLOWER_ADDRESS);

      expect(res.status).toBe(200);
      expect(res.body).toEqual(
         expect.objectContaining({
            success: true,
            data: expect.objectContaining({
               action: 'not_following',
               followersCount: 0,
            }),
         })
      );
   });

   it('returns 401 for unauthenticated follow request', async () => {
      const res = await supertest(app)
         .post(`/api/v1/creators/${CREATOR_ID}/follow`);

      expect(res.status).toBe(401);
      expect(res.body).toEqual(
         expect.objectContaining({
            success: false,
            error: expect.objectContaining({
               code: 'UNAUTHORIZED',
            }),
         })
      );
   });

   it('returns 404 when creator does not exist', async () => {
      mockedCreatorProfileExists.mockResolvedValue(false);

      const res = await supertest(app)
         .post(`/api/v1/creators/nonexistent-creator/follow`)
         .set('x-wallet-address', FOLLOWER_ADDRESS);

      expect(res.status).toBe(404);
      expect(res.body).toEqual(
         expect.objectContaining({
            success: false,
            error: expect.objectContaining({
               code: 'NOT_FOUND',
            }),
         })
      );
   });
});
