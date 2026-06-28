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
   getCreatorProfile: jest.fn(),
   upsertCreatorProfile: jest.fn(async (creatorId: string, payload: unknown) => ({
      creatorId,
      acceptedProfile: payload,
      metadata: { source: 'database', persisted: true },
   })),
}));

import supertest from 'supertest';
import app from '../../app';
import { withProtectedRouteHeaders } from '../../utils/test/protected-route-request.utils';
import * as walletOwnership from '../../utils/wallet-ownership.utils';

const mockedCheck =
   walletOwnership.checkCreatorProfileOwnership as jest.MockedFunction<
      typeof walletOwnership.checkCreatorProfileOwnership
   >;

describe('PUT /api/v1/creators/:creatorId/profile â€” protected route headers', () => {
   beforeEach(() => {
      mockedCheck.mockReset();
      mockedCheck.mockResolvedValue({
         status: 'granted',
         ownerUserId: 'user-1',
      });
   });

   it('accepts a request with the default protected headers', async () => {
      const res = await withProtectedRouteHeaders(
         supertest(app)
            .put('/api/v1/creators/creator-1/profile')
            .send({ displayName: 'Alice Example' })
      );

      expect(res.status).toBe(202);
      expect(res.body).toEqual(
         expect.objectContaining({
            success: true,
            data: expect.objectContaining({
               creatorId: 'creator-1',
               acceptedProfile: expect.objectContaining({
                  displayName: 'Alice Example',
               }),
            }),
         })
      );
   });

   it('returns 401 when the wallet header is removed through an override', async () => {
      const res = await withProtectedRouteHeaders(
         supertest(app)
            .put('/api/v1/creators/creator-1/profile')
            .send({ displayName: 'Alice Example' }),
         { 'x-wallet-address': undefined }
      );

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

   it('returns 400 when the wallet address has wrong length', async () => {
      const res = await supertest(app)
         .put('/api/v1/creators/creator-1/profile')
         .set('x-wallet-address', 'GSHORT')
         .send({ displayName: 'Alice Example' });

      expect(res.status).toBe(400);
      expect(res.body).toEqual(
         expect.objectContaining({
            success: false,
            error: expect.objectContaining({
               code: 'BAD_REQUEST',
            }),
         })
      );
      expect(res.body.error.details).toBeDefined();
      expect(res.body.error.details[0].field).toBe('x-wallet-address');
   });

   it('returns 400 when the wallet address has invalid characters', async () => {
      const res = await supertest(app)
         .put('/api/v1/creators/creator-1/profile')
         .set(
            'x-wallet-address',
            'G!!!!!AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
         )
         .send({ displayName: 'Alice Example' });

      expect(res.status).toBe(400);
      expect(res.body).toEqual(
         expect.objectContaining({
            success: false,
            error: expect.objectContaining({
               code: 'BAD_REQUEST',
            }),
         })
      );
      expect(res.body.error.details).toBeDefined();
      expect(res.body.error.details[0].field).toBe('x-wallet-address');
   });

   it('allows requests with a valid Stellar address format to reach the handler', async () => {
      const res = await supertest(app)
         .put('/api/v1/creators/creator-1/profile')
         .set(
            'x-wallet-address',
            'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
         )
         .send({ displayName: 'Alice Example' });

      expect(res.status).toBe(202);
      expect(res.body).toEqual(
         expect.objectContaining({
            success: true,
         })
      );
   });
});
