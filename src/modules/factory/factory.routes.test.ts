import request from 'supertest';
import app from '../../app';
import * as factoryService from './factory.service';
import { disconnectRedis } from '../../utils/redis.utils';

jest.mock('../../utils/redis.utils', () => {
   const actual = jest.requireActual('../../utils/redis.utils');
   return {
      ...actual,
      cacheGetJson: jest.fn().mockResolvedValue(null),
      cacheSetJson: jest.fn().mockResolvedValue(undefined),
      cacheInvalidate: jest.fn().mockResolvedValue(undefined),
   };
});

describe('Factory routes', () => {
   afterAll(async () => {
      await disconnectRedis();
   });

   afterEach(() => {
      jest.restoreAllMocks();
   });

   describe('GET /factory/keys', () => {
      it('returns keys deployed by a creator wallet, ordered by deployment order', async () => {
         jest
            .spyOn(factoryService, 'getFactoryKeysByCreator')
            .mockResolvedValueOnce([
               {
                  contractAddress: 'CADDR1',
                  creatorWallet: 'GCREATOR1',
                  keyId: 'key-1',
                  deployedAt: '2026-09-01T00:00:00.000Z',
                  is_factory_key: true,
               },
            ]);

         const res = await request(app).get(
            '/api/v1/factory/keys?creator=GCREATOR1'
         );
         expect(res.status).toBe(200);
         expect(res.body.success).toBe(true);
         expect(res.body.data.items).toHaveLength(1);
         expect(res.body.data.items[0].is_factory_key).toBe(true);
      });

      it('returns 400 when creator query param is missing', async () => {
         const res = await request(app).get('/api/v1/factory/keys');
         expect(res.status).toBe(400);
         expect(res.body.success).toBe(false);
      });
   });

   describe('GET /factory/keys/:contractAddress', () => {
      it('returns is_factory_key: true for a factory-registered key', async () => {
         jest
            .spyOn(factoryService, 'getKeyByFactoryAddress')
            .mockResolvedValueOnce({
               contractAddress: 'CADDR1',
               creatorWallet: 'GCREATOR1',
               keyId: 'key-1',
               deployedAt: '2026-09-01T00:00:00.000Z',
               is_factory_key: true,
            });

         const res = await request(app).get('/api/v1/factory/keys/CADDR1');
         expect(res.status).toBe(200);
         expect(res.body.data.is_factory_key).toBe(true);
      });

      it('returns is_factory_key: false for a non-factory registered key', async () => {
         jest
            .spyOn(factoryService, 'getKeyByFactoryAddress')
            .mockResolvedValueOnce({
               contractAddress: 'CADDR2',
               creatorWallet: 'GCREATOR2',
               is_factory_key: false,
            });

         const res = await request(app).get('/api/v1/factory/keys/CADDR2');
         expect(res.status).toBe(200);
         expect(res.body.data.is_factory_key).toBe(false);
      });

      it('returns 404 when the address is not a key anywhere', async () => {
         jest
            .spyOn(factoryService, 'getKeyByFactoryAddress')
            .mockRejectedValueOnce(
               new factoryService.KeyAddressNotFoundError('CUNKNOWN')
            );

         const res = await request(app).get('/api/v1/factory/keys/CUNKNOWN');
         expect(res.status).toBe(404);
         expect(res.body.success).toBe(false);
      });
   });
});
