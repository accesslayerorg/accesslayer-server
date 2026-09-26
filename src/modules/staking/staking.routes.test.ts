// src/modules/staking/staking.routes.test.ts
import request from 'supertest';
import app from '../../app';
import * as stakingService from './staking.service';
import { prisma } from '../../utils/prisma.utils';
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

describe('Staking Routes', () => {
   const mockTierData: stakingService.StakingMultiplierTierDto[] = [
      {
         tier: 0,
         name: 'Tier 0 (Flexible)',
         lockPeriod: 0,
         lockPeriodSeconds: 0,
         lockPeriodDays: 0,
         multiplier: 1.0,
         multiplierFormatted: '1x',
      },
      {
         tier: 1,
         name: 'Tier 1 (30 Days)',
         lockPeriod: 2592000,
         lockPeriodSeconds: 2592000,
         lockPeriodDays: 30,
         multiplier: 1.25,
         multiplierFormatted: '1.25x',
      },
      {
         tier: 2,
         name: 'Tier 2 (90 Days)',
         lockPeriod: 7776000,
         lockPeriodSeconds: 7776000,
         lockPeriodDays: 90,
         multiplier: 1.5,
         multiplierFormatted: '1.5x',
      },
   ];

   const mockPosition: stakingService.StakingPositionResponse = {
      id: 'pos-abc-123',
      wallet: 'GBTESTSTAKER0001',
      keyId: 'creator-key-99',
      amount: '500',
      stakedAmount: '500',
      lockPeriodSeconds: 2592000,
      lockPeriod: 2592000,
      lockedAt: '2026-09-01T00:00:00.000Z',
      unlocksAt: '2026-10-01T00:00:00.000Z',
      tier: 1,
      effectiveWeight: '625', // 500 * 1.25
      tierData: mockTierData[1],
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
      updatedAt: new Date('2026-09-01T00:00:00.000Z'),
   };

   beforeEach(() => {
      jest.clearAllMocks();
   });

   afterAll(async () => {
      await disconnectRedis();
   });

   describe('GET /staking/multiplier-tiers', () => {
      it('returns all tiers with lock period and multiplier (both at /staking and /api/v1/staking)', async () => {
         jest
            .spyOn(stakingService, 'getMultiplierTiers')
            .mockResolvedValueOnce(mockTierData);

         const res1 = await request(app).get('/staking/multiplier-tiers');
         expect(res1.status).toBe(200);
         expect(res1.body.success).toBe(true);
         expect(res1.body.data).toHaveLength(3);
         expect(res1.body.data[0].tier).toBe(0);
         expect(res1.body.data[0].multiplier).toBe(1.0);
         expect(res1.body.data[1].tier).toBe(1);
         expect(res1.body.data[1].lockPeriodSeconds).toBe(2592000);
         expect(res1.body.data[1].lockPeriod).toBe(2592000);
         expect(res1.body.data[1].multiplier).toBe(1.25);

         jest
            .spyOn(stakingService, 'getMultiplierTiers')
            .mockResolvedValueOnce(mockTierData);

         const res2 = await request(app).get(
            '/api/v1/staking/multiplier-tiers'
         );
         expect(res2.status).toBe(200);
         expect(res2.body.success).toBe(true);
         expect(res2.body.data).toHaveLength(3);
      });

      it('returns 405 Method Not Allowed for non-GET methods', async () => {
         const res = await request(app)
            .post('/staking/multiplier-tiers')
            .send({});
         expect(res.status).toBe(405);
         expect(res.headers.allow).toBe('GET');
      });
   });

   describe('GET /staking/positions/:id/effective-weight', () => {
      it('returns 200 with weighted stake calculation for an existing position', async () => {
         jest
            .spyOn(stakingService, 'getPositionEffectiveWeight')
            .mockResolvedValueOnce({
               positionId: 'pos-abc-123',
               wallet: 'GBTESTSTAKER0001',
               stakedAmount: '500',
               lockPeriodSeconds: 2592000,
               lockPeriod: 2592000,
               multiplier: 1.25,
               multiplierFormatted: '1.25x',
               effectiveWeight: '625',
               tier: mockTierData[1],
            });

         const res = await request(app).get(
            '/staking/positions/pos-abc-123/effective-weight'
         );
         expect(res.status).toBe(200);
         expect(res.body.success).toBe(true);
         expect(res.body.data.positionId).toBe('pos-abc-123');
         expect(res.body.data.effectiveWeight).toBe('625');
         expect(res.body.data.stakedAmount).toBe('500');
         expect(res.body.data.multiplier).toBe(1.25);
         expect(res.body.data.tier.tier).toBe(1);
      });

      it('returns 404 when position is not found', async () => {
         jest
            .spyOn(stakingService, 'getPositionEffectiveWeight')
            .mockRejectedValueOnce(
               new stakingService.StakingPositionNotFoundError('non-existent')
            );

         const res = await request(app).get(
            '/staking/positions/non-existent/effective-weight'
         );
         expect(res.status).toBe(404);
         expect(res.body.success).toBe(false);
         expect(res.body.error.message).toContain('Staking position');
      });

      it('returns 405 Method Not Allowed for non-GET methods', async () => {
         const res = await request(app)
            .post('/staking/positions/pos-123/effective-weight')
            .send({});
         expect(res.status).toBe(405);
         expect(res.headers.allow).toBe('GET');
      });
   });

   describe('GET /staking/positions/:id', () => {
      it('returns staking position with embedded tier data and effective weight', async () => {
         jest
            .spyOn(stakingService, 'getStakingPositionById')
            .mockResolvedValueOnce(mockPosition);

         const res = await request(app).get('/staking/positions/pos-abc-123');
         expect(res.status).toBe(200);
         expect(res.body.success).toBe(true);
         expect(res.body.data.id).toBe('pos-abc-123');
         expect(res.body.data.effectiveWeight).toBe('625');
         expect(res.body.data.tierData).toBeDefined();
         expect(res.body.data.tierData.tier).toBe(1);
         expect(res.body.data.tierData.multiplier).toBe(1.25);
      });

      it('returns 404 when position is not found', async () => {
         jest
            .spyOn(stakingService, 'getStakingPositionById')
            .mockRejectedValueOnce(
               new stakingService.StakingPositionNotFoundError('unknown-id')
            );

         const res = await request(app).get('/staking/positions/unknown-id');
         expect(res.status).toBe(404);
         expect(res.body.success).toBe(false);
      });
   });

   describe('GET /staking/positions', () => {
      it('returns list of staking positions with embedded tier data', async () => {
         jest
            .spyOn(stakingService, 'getStakingPositions')
            .mockResolvedValueOnce([mockPosition]);

         const res = await request(app).get(
            '/staking/positions?wallet=GBTESTSTAKER0001'
         );
         expect(res.status).toBe(200);
         expect(res.body.success).toBe(true);
         expect(res.body.data).toHaveLength(1);
         expect(res.body.data[0].effectiveWeight).toBe('625');
         expect(res.body.data[0].tierData.tier).toBe(1);
      });
   });

   describe('Key position response with embedded tier data (GET /api/v1/keys/:keyId/positions)', () => {
      it('embeds tierData and effectiveWeight in the key position response', async () => {
         const testWallet = 'GBTESTKEYHOLDER0001';
         const testToken = signWalletAccessToken(testWallet);

         (prisma as any).creatorProfile = {
            findFirst: jest.fn().mockResolvedValue({ id: 'creator-123' }),
         };

         (prisma as any).keyOwnership = {
            findUnique: jest.fn().mockResolvedValue({
               id: 'ownership-pos-1',
               ownerAddress: testWallet,
               creatorId: 'creator-123',
               balance: 400,
               costBasis: '10',
               lastBuyAt: new Date('2026-08-01T00:00:00Z'),
               lockupExpiresAt: new Date('2026-08-31T00:00:00Z'), // ~30 days
               frozen: false,
               frozenAt: null,
               createdAt: new Date('2026-08-01T00:00:00Z'),
               updatedAt: new Date('2026-08-01T00:00:00Z'),
            }),
         };

         jest
            .spyOn(stakingService, 'getMultiplierTiers')
            .mockResolvedValueOnce(mockTierData);

         const res = await request(app)
            .get('/api/v1/keys/creator-123/positions')
            .set('Authorization', `Bearer ${testToken}`);

         expect(res.status).toBe(200);
         expect(res.body.success).toBe(true);
         expect(res.body.data.id).toBe('ownership-pos-1');
         expect(res.body.data.tier).toBe(1);
         expect(res.body.data.multiplier).toBe(1.25);
         expect(res.body.data.effectiveWeight).toBe('500'); // 400 * 1.25
         expect(res.body.data.tierData).toBeDefined();
         expect(res.body.data.tierData.lockPeriodSeconds).toBe(2592000);
      });
   });
});
