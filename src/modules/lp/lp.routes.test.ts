import request from 'supertest';
import app from '../../app';
import * as lpService from './lp.service';
import { signWalletAccessToken } from '../../utils/jwt.utils';
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

describe('LP routes', () => {
   const wallet = 'GLPWALLET0000000000000000000000000000000000000000000';
   const token = signWalletAccessToken(wallet);

   afterAll(async () => {
      await disconnectRedis();
   });

   afterEach(() => {
      jest.restoreAllMocks();
   });

   describe('GET /api/v1/lp/positions', () => {
      it('returns 401 without a token', async () => {
         const res = await request(app).get(
            `/api/v1/lp/positions?wallet=${wallet}`
         );
         expect(res.status).toBe(401);
      });

      it('returns 403 when the query wallet does not match the authenticated wallet', async () => {
         const res = await request(app)
            .get('/api/v1/lp/positions?wallet=GDIFFERENTWALLET')
            .set('Authorization', `Bearer ${token}`);
         expect(res.status).toBe(403);
      });

      it('returns active LP positions for the authenticated wallet', async () => {
         jest.spyOn(lpService, 'getLpPositionsByWallet').mockResolvedValueOnce([
            {
               lpId: 'lp-1',
               wallet,
               keyId: 'key-1',
               sharePercent: '10',
               accruedRewards: '5.5',
               status: 'active',
               createdAt: '2026-09-01T00:00:00.000Z',
               updatedAt: '2026-09-01T00:00:00.000Z',
            },
         ]);

         const res = await request(app)
            .get(`/api/v1/lp/positions?wallet=${wallet}`)
            .set('Authorization', `Bearer ${token}`);
         expect(res.status).toBe(200);
         expect(res.body.data.items).toHaveLength(1);
         expect(res.body.data.items[0].sharePercent).toBe('10');
      });
   });

   describe('GET /api/v1/lp/positions/:lpId', () => {
      it('returns 401 without a token', async () => {
         const res = await request(app).get('/api/v1/lp/positions/lp-1');
         expect(res.status).toBe(401);
      });

      it('returns 404 when the position does not exist or is not owned by the wallet', async () => {
         jest
            .spyOn(lpService, 'getLpPositionById')
            .mockRejectedValueOnce(
               new lpService.LpPositionNotFoundError('lp-1')
            );

         const res = await request(app)
            .get('/api/v1/lp/positions/lp-1')
            .set('Authorization', `Bearer ${token}`);
         expect(res.status).toBe(404);
      });

      it('returns position detail when found and owned', async () => {
         jest.spyOn(lpService, 'getLpPositionById').mockResolvedValueOnce({
            lpId: 'lp-1',
            wallet,
            keyId: 'key-1',
            sharePercent: '10',
            accruedRewards: '5.5',
            status: 'active',
            createdAt: '2026-09-01T00:00:00.000Z',
            updatedAt: '2026-09-01T00:00:00.000Z',
         });

         const res = await request(app)
            .get('/api/v1/lp/positions/lp-1')
            .set('Authorization', `Bearer ${token}`);
         expect(res.status).toBe(200);
         expect(res.body.data.lpId).toBe('lp-1');
      });
   });

   describe('GET /api/v1/lp/pool/:keyId', () => {
      it('returns pool size and APR estimate without auth', async () => {
         jest.spyOn(lpService, 'getLpPoolSummary').mockResolvedValueOnce({
            keyId: 'key-1',
            totalPoolSize: '100',
            estimatedApr: 12.5,
         });

         const res = await request(app).get('/api/v1/lp/pool/key-1');
         expect(res.status).toBe(200);
         expect(res.body.data.totalPoolSize).toBe('100');
         expect(res.body.data.estimatedApr).toBe(12.5);
      });
   });
});
