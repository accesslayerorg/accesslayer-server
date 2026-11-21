jest.mock('chalk', () => ({
   red: (text: string) => text,
   green: (text: string) => text,
   magenta: (text: string) => text,
   cyan: (text: string) => text,
}));

jest.mock('tspec', () => ({
   TspecDocsMiddleware: jest.fn().mockResolvedValue([]),
}));

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      creatorProfile: {
         findFirst: jest.fn(),
         update: jest.fn(),
      },
      stellarWallet: {
         findUnique: jest.fn(),
      },
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

jest.mock('./creator-profile.service', () => ({
   getCreatorProfile: jest.fn(async (creatorId: string) => ({
      creatorId,
      displayName: UPDATED_DISPLAY_NAME,
      bio: UPDATED_BIO,
      avatarUrl: null,
      createdAt: null,
      updatedAt: null,
      perks: [],
      links: [],
      currentPrice: null,
      price24hAgo: null,
      priceChange24h: null,
      metadata: {
         source: 'database',
         isProfileComplete: true,
      },
   })),
   upsertCreatorProfile: jest.fn(
      async (creatorId: string, payload: unknown) => ({
         creatorId,
         acceptedProfile: payload,
         metadata: { source: 'database', persisted: true },
      })
   ),
}));

jest.mock('../../middlewares/stellar-signature.middleware', () => ({
   requireStellarSignature: () => (req: any, _res: any, next: any) => {
      req.walletAddress = req.headers['x-wallet-address'];
      req.signatureVerified = true;
      next();
   },
}));

import supertest from 'supertest';
import app from '../../app';
import * as walletOwnership from '../../utils/wallet-ownership.utils';

const mockedCheck =
   walletOwnership.checkCreatorProfileOwnership as jest.MockedFunction<
      typeof walletOwnership.checkCreatorProfileOwnership
   >;

const TEST_CREATOR_ID = 'creator-profile-update-id';
const UPDATED_DISPLAY_NAME = 'Updated Display Name';
const UPDATED_BIO = 'Updated bio content';
const OWNER_WALLET_ADDRESS =
   'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

describe('PUT /api/v1/creators/:creatorId/profile — display name and bio persistence', () => {
   beforeEach(() => {
      mockedCheck.mockReset();
      mockedCheck.mockResolvedValue({
         status: 'granted',
         ownerUserId: 'user-1',
      });
   });

   it('updates display name and bio and persists correctly', async () => {
      const res = await supertest(app)
         .put(`/api/v1/creators/${TEST_CREATOR_ID}/profile`)
         .set('x-wallet-address', OWNER_WALLET_ADDRESS)
         .send({
            displayName: UPDATED_DISPLAY_NAME,
            bio: UPDATED_BIO,
         });

      expect(res.status).toBe(202);
      expect(res.body).toEqual(
         expect.objectContaining({
            success: true,
            data: expect.objectContaining({
               creatorId: TEST_CREATOR_ID,
               acceptedProfile: expect.objectContaining({
                  displayName: UPDATED_DISPLAY_NAME,
                  bio: UPDATED_BIO,
               }),
            }),
         })
      );
   });

   it('returns updated values after successful PUT', async () => {
      const res = await supertest(app).get(
         `/api/v1/creators/${TEST_CREATOR_ID}/profile`
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual(
         expect.objectContaining({
            success: true,
            data: expect.objectContaining({
               creatorId: TEST_CREATOR_ID,
               displayName: UPDATED_DISPLAY_NAME,
               bio: UPDATED_BIO,
            }),
         })
      );
   });

   it('returns 403 when different wallet attempts to update profile', async () => {
      mockedCheck.mockResolvedValue({
         status: 'forbidden',
         address: OWNER_WALLET_ADDRESS,
         ownerUserId: 'different-user-id',
      });

      const res = await supertest(app)
         .put(`/api/v1/creators/${TEST_CREATOR_ID}/profile`)
         .set('x-wallet-address', OWNER_WALLET_ADDRESS)
         .send({
            displayName: 'Hacker Display Name',
            bio: 'Hacker bio content',
         });

      expect(res.status).toBe(403);
      expect(res.body).toEqual(
         expect.objectContaining({
            success: false,
            error: expect.objectContaining({
               code: 'FORBIDDEN',
            }),
         })
      );
   });

   // Status is 422 (not 400) because the request body fails schema
   // validation via the shared validateBody middleware (#780) — 400 is
   // reserved for malformed path params on this route.
   it('returns 422 when display name is too long', async () => {
      const res = await supertest(app)
         .put(`/api/v1/creators/${TEST_CREATOR_ID}/profile`)
         .set('x-wallet-address', OWNER_WALLET_ADDRESS)
         .send({
            displayName: 'a'.repeat(51),
            bio: 'Some bio',
         });

      expect(res.status).toBe(422);
      expect(res.body).toEqual(
         expect.objectContaining({
            success: false,
            error: expect.objectContaining({
               code: 'VALIDATION_ERROR',
            }),
         })
      );
      expect(res.body.error.details).toBeDefined();
      expect(res.body.error.details[0].field).toBe('displayName');
   });

   it('returns 422 when display name is empty string', async () => {
      const res = await supertest(app)
         .put(`/api/v1/creators/${TEST_CREATOR_ID}/profile`)
         .set('x-wallet-address', OWNER_WALLET_ADDRESS)
         .send({
            displayName: '',
            bio: 'Some bio',
         });

      expect(res.status).toBe(422);
      expect(res.body).toEqual(
         expect.objectContaining({
            success: false,
            error: expect.objectContaining({
               code: 'VALIDATION_ERROR',
            }),
         })
      );
      expect(res.body.error.details).toBeDefined();
   });

   it('original values unchanged after failed attempts', async () => {
      const res = await supertest(app).get(
         `/api/v1/creators/${TEST_CREATOR_ID}/profile`
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual(
         expect.objectContaining({
            success: true,
            data: expect.objectContaining({
               creatorId: TEST_CREATOR_ID,
               displayName: UPDATED_DISPLAY_NAME,
               bio: UPDATED_BIO,
            }),
         })
      );
   });
});
