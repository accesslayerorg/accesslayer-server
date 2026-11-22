// src/routes/price-ceiling.routes.test.ts

jest.mock('../modules/keys/price-ceiling.service', () => {
   class MockKeyNotFoundError extends Error {
      constructor(keyId: string) {
         super(`Key not found: ${keyId}`);
         this.name = 'KeyNotFoundError';
      }
   }
   return {
      KeyNotFoundError: MockKeyNotFoundError,
      getPriceCeilingStatus: jest.fn(),
   };
});

jest.mock('../modules/creator/creator-profile.service', () => ({
   getCreatorProfile: jest.fn(),
   creatorProfileExists: jest.fn(),
}));

import express from 'express';
import supertest from 'supertest';
import keysRoutes from './keys.routes';
import modulesKeysRouter from '../modules/keys/keys.routes';
import {
   getPriceCeilingStatus,
   KeyNotFoundError,
} from '../modules/keys/price-ceiling.service';
import {
   getCreatorProfile,
   creatorProfileExists,
} from '../modules/creator/creator-profile.service';

const getPriceCeilingStatusMock = getPriceCeilingStatus as jest.Mock;
const getCreatorProfileMock = getCreatorProfile as jest.Mock;
const creatorProfileExistsMock = creatorProfileExists as jest.Mock;

function createApp() {
   const app = express();
   app.use('/v1', keysRoutes);
   app.use('/api/v1/keys', modulesKeysRouter);
   return app;
}

describe('GET /v1/keys/:keyId/ceiling and Key Detail', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   describe('GET /v1/keys/:keyId/ceiling', () => {
      it('returns ceiling, headroom, and cool-off state for a key with ceiling', async () => {
         getPriceCeilingStatusMock.mockResolvedValue({
            keyId: 'key-1',
            ceiling: 1000,
            price: 200,
            headroom: 0.8,
            headroomPercentage: 80,
            cooloffActive: true,
            cooloffEndsAt: 150,
            cooloffLedgers: 50,
         });

         const response = await supertest(createApp()).get(
            '/v1/keys/key-1/ceiling'
         );

         expect(response.status).toBe(200);
         expect(response.body).toEqual({
            success: true,
            data: {
               keyId: 'key-1',
               ceiling: 1000,
               price: 200,
               headroom: 0.8,
               headroomPercentage: 80,
               cooloffActive: true,
               cooloffEndsAt: 150,
               cooloffLedgers: 50,
            },
            message: 'Price ceiling retrieved successfully',
         });
         expect(getPriceCeilingStatusMock).toHaveBeenCalledWith('key-1');
      });

      it('returns null ceiling fields for keys without a ceiling', async () => {
         getPriceCeilingStatusMock.mockResolvedValue({
            keyId: 'key-no-ceiling',
            ceiling: null,
            price: null,
            headroom: null,
            headroomPercentage: null,
            cooloffActive: null,
            cooloffEndsAt: null,
            cooloffLedgers: null,
         });

         const response = await supertest(createApp()).get(
            '/v1/keys/key-no-ceiling/ceiling'
         );

         expect(response.status).toBe(200);
         expect(response.body.data.ceiling).toBeNull();
         expect(response.body.data.headroom).toBeNull();
         expect(response.body.data.cooloffActive).toBeNull();
      });

      it('returns 404 when key does not exist', async () => {
         getPriceCeilingStatusMock.mockRejectedValue(
            new KeyNotFoundError('missing-key')
         );

         const response = await supertest(createApp()).get(
            '/v1/keys/missing-key/ceiling'
         );

         expect(response.status).toBe(404);
         expect(response.body.success).toBe(false);
      });
   });

   describe('Key detail includes ceiling and cooloffActive fields', () => {
      it('includes ceiling and cooloffActive in key detail response', async () => {
         creatorProfileExistsMock.mockResolvedValue(true);
         getCreatorProfileMock.mockResolvedValue({
            creatorId: 'key-1',
            displayName: 'Creator One',
            currentPrice: '200',
            ceiling: 1000,
            cooloffActive: false,
         });

         const response =
            await supertest(createApp()).get('/api/v1/keys/key-1');

         expect(response.status).toBe(200);
         expect(response.body.data.ceiling).toBe(1000);
         expect(response.body.data.cooloffActive).toBe(false);
      });

      it('returns null ceiling fields for keys without a ceiling in key detail', async () => {
         creatorProfileExistsMock.mockResolvedValue(true);
         getCreatorProfileMock.mockResolvedValue({
            creatorId: 'key-2',
            displayName: 'Creator Two',
            currentPrice: '200',
            ceiling: null,
            cooloffActive: null,
         });

         const response =
            await supertest(createApp()).get('/api/v1/keys/key-2');

         expect(response.status).toBe(200);
         expect(response.body.data.ceiling).toBeNull();
         expect(response.body.data.cooloffActive).toBeNull();
      });
   });
});
