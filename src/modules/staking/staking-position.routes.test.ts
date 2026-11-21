// src/modules/staking/staking-position.routes.test.ts
// POST /staking/stake and POST /staking/unstake (#881).
import request from 'supertest';
import app from '../../app';
import * as stakingService from './staking.service';
import {
   parseLockPeriodOptions,
   STAKING_EVENTS,
   stakingEventEmitter,
   StakingEventPayload,
} from './staking-position.service';
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

const WALLET = 'GBTESTSTAKER0001';
const DAY = 86400;

const tiers: stakingService.StakingMultiplierTierDto[] = [
   {
      tier: 0,
      name: 'Tier 0',
      lockPeriod: 0,
      lockPeriodSeconds: 0,
      lockPeriodDays: 0,
      multiplier: 1,
      multiplierFormatted: '1x',
   },
   {
      tier: 1,
      name: 'Tier 1',
      lockPeriod: 30 * DAY,
      lockPeriodSeconds: 30 * DAY,
      lockPeriodDays: 30,
      multiplier: 1.25,
      multiplierFormatted: '1.25x',
   },
];

describe('Staking position endpoints (#881)', () => {
   let token: string;
   let positionDb: {
      create: jest.Mock;
      findUnique: jest.Mock;
      updateMany: jest.Mock;
   };
   const events: Array<{ event: string; payload: StakingEventPayload }> = [];

   const onStaked = (payload: StakingEventPayload) =>
      events.push({ event: STAKING_EVENTS.STAKED, payload });
   const onUnstaked = (payload: StakingEventPayload) =>
      events.push({ event: STAKING_EVENTS.UNSTAKED, payload });

   beforeAll(async () => {
      token = signWalletAccessToken(WALLET);
      stakingEventEmitter.on(STAKING_EVENTS.STAKED, onStaked);
      stakingEventEmitter.on(STAKING_EVENTS.UNSTAKED, onUnstaked);
      // Warm up the app (first request is slow on cold start, e.g. on Windows)
      // so the 30s per-test timeout is not spent on module loading.
      await request(app).post('/staking/stake').send({});
   }, 120_000);

   afterAll(async () => {
      stakingEventEmitter.off(STAKING_EVENTS.STAKED, onStaked);
      stakingEventEmitter.off(STAKING_EVENTS.UNSTAKED, onUnstaked);
      await disconnectRedis();
   });

   beforeEach(() => {
      jest.restoreAllMocks();
      events.length = 0;
      jest.spyOn(stakingService, 'getMultiplierTiers').mockResolvedValue(tiers);
      positionDb = {
         create: jest.fn(),
         findUnique: jest.fn(),
         updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      };
      (prisma as any).stakingPosition = positionDb;
      (prisma as any).creatorProfile = {
         findUnique: jest.fn().mockResolvedValue({ id: 'creator-1' }),
      };
   });

   describe('parseLockPeriodOptions', () => {
      it('parses name=seconds pairs and skips malformed entries', () => {
         expect(
            parseLockPeriodOptions('flexible=0, 30d=2592000,bad,x=-1,y=abc')
         ).toEqual({
            flexible: 0,
            '30d': 2592000,
         });
      });
   });

   describe('POST /staking/stake', () => {
      it('creates a position with the correct lock expiry and emits a staked event', async () => {
         positionDb.create.mockResolvedValue({ id: 'pos-1' });
         const before = Date.now();

         const res = await request(app)
            .post('/staking/stake')
            .set('Authorization', `Bearer ${token}`)
            .send({ keyId: 'creator-1', amount: '100.5', lockPeriod: '30d' });

         expect(res.status).toBe(201);
         expect(res.body.data).toMatchObject({
            id: 'pos-1',
            wallet: WALLET,
            keyId: 'creator-1',
            amount: '100.5',
            lockPeriod: '30d',
            lockPeriodSeconds: 30 * DAY,
            tier: 1,
            effectiveWeight: '125.625',
         });

         const data = positionDb.create.mock.calls[0][0].data;
         expect(data.wallet).toBe(WALLET);
         expect(data.lockPeriodSeconds).toBe(30 * DAY);
         expect(data.unlocksAt.getTime() - data.lockedAt.getTime()).toBe(
            30 * DAY * 1000
         );
         expect(data.lockedAt.getTime()).toBeGreaterThanOrEqual(before);

         expect(events).toHaveLength(1);
         expect(events[0].event).toBe(STAKING_EVENTS.STAKED);
         expect(events[0].payload).toMatchObject({
            positionId: 'pos-1',
            wallet: WALLET,
            keyId: 'creator-1',
            amount: '100.5',
            lockPeriodSeconds: 30 * DAY,
            tier: 1,
         });
      });

      it('rejects an invalid lock period with 400 and the valid options', async () => {
         const res = await request(app)
            .post('/staking/stake')
            .set('Authorization', `Bearer ${token}`)
            .send({ keyId: 'creator-1', amount: '10', lockPeriod: '7d' });

         expect(res.status).toBe(400);
         const message = res.body.error.details[0].message as string;
         expect(message).toContain('flexible');
         expect(message).toContain('30d');
         expect(message).toContain('365d');
         expect(positionDb.create).not.toHaveBeenCalled();
         expect(events).toHaveLength(0);
      });

      it.each([
         [
            'zero amount',
            { keyId: 'creator-1', amount: '0', lockPeriod: '30d' },
         ],
         [
            'negative amount',
            { keyId: 'creator-1', amount: '-5', lockPeriod: '30d' },
         ],
         [
            'non-numeric amount',
            { keyId: 'creator-1', amount: 'abc', lockPeriod: '30d' },
         ],
         ['missing keyId', { amount: '5', lockPeriod: '30d' }],
      ])('returns 400 for %s', async (_name, body) => {
         const res = await request(app)
            .post('/staking/stake')
            .set('Authorization', `Bearer ${token}`)
            .send(body);
         expect(res.status).toBe(400);
         expect(positionDb.create).not.toHaveBeenCalled();
      });

      it('returns 404 when the key does not exist', async () => {
         (prisma as any).creatorProfile.findUnique.mockResolvedValue(null);
         const res = await request(app)
            .post('/staking/stake')
            .set('Authorization', `Bearer ${token}`)
            .send({ keyId: 'missing', amount: '10', lockPeriod: '30d' });
         expect(res.status).toBe(404);
         expect(positionDb.create).not.toHaveBeenCalled();
      });

      it('requires authentication', async () => {
         const res = await request(app)
            .post('/staking/stake')
            .send({ keyId: 'creator-1', amount: '10', lockPeriod: '30d' });
         expect(res.status).toBe(401);
      });

      it('returns 405 for other methods', async () => {
         const res = await request(app).get('/staking/stake');
         expect(res.status).toBe(405);
      });
   });

   describe('POST /staking/unstake', () => {
      const basePosition = {
         id: 'pos-1',
         wallet: WALLET,
         keyId: 'creator-1',
         amount: { toString: () => '100.5' },
         lockPeriodSeconds: 30 * DAY,
         lockedAt: new Date(Date.now() - 31 * DAY * 1000),
         unlocksAt: new Date(Date.now() - DAY * 1000),
         tier: 1,
         unstakedAt: null,
      };

      const unstake = (positionId = 'pos-1') =>
         request(app)
            .post('/staking/unstake')
            .set('Authorization', `Bearer ${token}`)
            .send({ positionId });

      it('unstakes once the lock period has expired and emits an unstaked event', async () => {
         positionDb.findUnique.mockResolvedValue(basePosition);

         const res = await unstake();

         expect(res.status).toBe(200);
         expect(res.body.data).toMatchObject({
            id: 'pos-1',
            wallet: WALLET,
            amount: '100.5',
         });
         expect(res.body.data.unstakedAt).toEqual(expect.any(String));
         expect(positionDb.updateMany).toHaveBeenCalledWith({
            where: { id: 'pos-1', unstakedAt: null },
            data: { unstakedAt: expect.any(Date) },
         });
         expect(events).toHaveLength(1);
         expect(events[0].event).toBe(STAKING_EVENTS.UNSTAKED);
         expect(events[0].payload).toMatchObject({
            positionId: 'pos-1',
            tier: 1,
         });
      });

      it('rejects with 403 when the lock period has not expired', async () => {
         positionDb.findUnique.mockResolvedValue({
            ...basePosition,
            unlocksAt: new Date(Date.now() + DAY * 1000),
         });

         const res = await unstake();

         expect(res.status).toBe(403);
         expect(res.body.error.details[0].message).toContain('Unlocks at');
         expect(positionDb.updateMany).not.toHaveBeenCalled();
         expect(events).toHaveLength(0);
      });

      it('returns 404 for an unknown position or one owned by another wallet', async () => {
         positionDb.findUnique.mockResolvedValueOnce(null);
         expect((await unstake('nope')).status).toBe(404);

         positionDb.findUnique.mockResolvedValueOnce({
            ...basePosition,
            wallet: 'GOTHER',
         });
         expect((await unstake()).status).toBe(404);
         expect(positionDb.updateMany).not.toHaveBeenCalled();
      });

      it('returns 409 when the position was already unstaked', async () => {
         positionDb.findUnique.mockResolvedValue({
            ...basePosition,
            unstakedAt: new Date(),
         });
         expect((await unstake()).status).toBe(409);
         expect(positionDb.updateMany).not.toHaveBeenCalled();
      });

      it('returns 409 when a concurrent unstake wins the race', async () => {
         positionDb.findUnique.mockResolvedValue(basePosition);
         positionDb.updateMany.mockResolvedValue({ count: 0 });
         expect((await unstake()).status).toBe(409);
         expect(events).toHaveLength(0);
      });

      it('returns 400 for a missing positionId and 401 without a token', async () => {
         const bad = await request(app)
            .post('/staking/unstake')
            .set('Authorization', `Bearer ${token}`)
            .send({});
         expect(bad.status).toBe(400);

         const anon = await request(app)
            .post('/staking/unstake')
            .send({ positionId: 'pos-1' });
         expect(anon.status).toBe(401);
      });
   });
});
