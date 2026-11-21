// Integration test: GET /api/v1/keys/:keyId/cooldown and GET /api/v1/cooldowns (#968)

import supertest from 'supertest';
import app from '../../app';
import { prisma } from '../../utils/prisma.utils';

const redisStore = new Map<string, unknown>();

jest.mock('../../utils/redis.utils', () => ({
   ...jest.requireActual('../../utils/redis.utils'),
   getRedis: () => null,
   getRedisClient: () => null,
   cacheGetJson: jest.fn(async (key: string) => redisStore.get(key) ?? null),
   cacheSetJson: jest.fn(async (key: string, value: unknown) => {
      redisStore.set(key, value);
   }),
   cacheInvalidate: jest.fn(async (...keys: string[]) => {
      for (const k of keys) {
         redisStore.delete(k);
      }
   }),
}));

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      creatorProfile: { findFirst: jest.fn() },
      trade: { findFirst: jest.fn() },
      indexedLedger: { findUnique: jest.fn() },
   },
}));

const mockPrisma = prisma as unknown as {
   creatorProfile: { findFirst: jest.Mock };
   trade: { findFirst: jest.Mock };
   indexedLedger: { findUnique: jest.Mock };
};

const WALLET = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';

describe('Cooldown Status APIs (#968)', () => {
   beforeEach(() => {
      redisStore.clear();
      jest.clearAllMocks();
   });

   describe('GET /api/v1/keys/:keyId/cooldown', () => {
      const url = (keyId: string, wallet?: string) =>
         `/api/v1/keys/${keyId}/cooldown${wallet ? `?wallet=${wallet}` : ''}`;

      it('returns cooldown status with policy duration', async () => {
         mockPrisma.creatorProfile.findFirst.mockResolvedValue({
            id: 'key-1',
            cooldownLedgers: 10,
         });
         mockPrisma.trade.findFirst.mockResolvedValue({ ledger: 100 });
         mockPrisma.indexedLedger.findUnique.mockResolvedValue({ ledger: 102 }); // 100 + 10 - 102 = 8 ledgers remaining = 40s

         const res = await supertest(app).get(url('key-1', WALLET));

         expect(res.status).toBe(200);
         expect(res.body.data).toMatchObject({
            key_id: 'key-1',
            wallet: WALLET,
            active: true,
            cooldown_active: true,
            seconds_remaining: 40,
            cooldown_ledgers: 10,
            cooldown_seconds: 50,
         });
         expect(res.body.data.expires_at).toBeDefined();
      });

      it('returns 400 when wallet query param is missing', async () => {
         const res = await supertest(app).get(url('key-1'));
         expect(res.status).toBe(400);
      });

      it('returns 400 when wallet is invalid', async () => {
         const res = await supertest(app).get(url('key-1', 'invalid-wallet'));
         expect(res.status).toBe(400);
      });

      it('returns 404 when key is not found', async () => {
         mockPrisma.creatorProfile.findFirst.mockResolvedValue(null);
         const res = await supertest(app).get(url('missing', WALLET));
         expect(res.status).toBe(404);
      });
   });

   describe('GET /api/v1/cooldowns', () => {
      const batchUrl = (keys: string[], wallet?: string) =>
         `/api/v1/cooldowns?wallet=${wallet ?? ''}&keys=${keys.join(',')}`;

      it('returns batch cooldown status for up to 50 keys', async () => {
         mockPrisma.creatorProfile.findFirst.mockResolvedValue({
            id: 'key-1',
            cooldownLedgers: 5,
         });
         mockPrisma.trade.findFirst.mockResolvedValue(null);
         mockPrisma.indexedLedger.findUnique.mockResolvedValue({ ledger: 100 });

         const keys = ['key-1', 'key-2'];
         const res = await supertest(app).get(batchUrl(keys, WALLET));

         expect(res.status).toBe(200);
         expect(Array.isArray(res.body.data)).toBe(true);
         expect(res.body.data).toHaveLength(2);
         expect(res.body.data[0]).toMatchObject({
            key_id: 'key-1',
            active: false,
            cooldown_ledgers: 5,
            cooldown_seconds: 25,
         });
      });

      it('returns 400 when keys parameter exceeds 50 IDs', async () => {
         const keys = Array.from({ length: 51 }, (_, i) => `key-${i + 1}`);
         const res = await supertest(app).get(batchUrl(keys, WALLET));
         expect(res.status).toBe(400);
      });

      it('returns 400 when wallet parameter is missing', async () => {
         const res = await supertest(app).get('/api/v1/cooldowns?keys=key-1');
         expect(res.status).toBe(400);
      });
   });

   describe('GET /api/v1/keys/:keyId/cooldown/:wallet (#1060)', () => {
      const pathUrl = (keyId: string, wallet: string) =>
         `/api/v1/keys/${keyId}/cooldown/${wallet}`;

      it('returns cooldown status with is_active, seconds_remaining, and last_trade_at', async () => {
         const tradeTimestamp = new Date('2026-10-18T00:00:00.000Z');
         mockPrisma.creatorProfile.findFirst.mockResolvedValue({
            id: 'key-1',
            cooldownLedgers: 10,
         });
         mockPrisma.trade.findFirst.mockResolvedValue({
            ledger: 100,
            timestamp: tradeTimestamp,
         });
         mockPrisma.indexedLedger.findUnique.mockResolvedValue({ ledger: 102 }); // 8 ledgers * 5 = 40s

         const res = await supertest(app).get(pathUrl('key-1', WALLET));

         expect(res.status).toBe(200);
         expect(res.body.data).toEqual({
            is_active: true,
            seconds_remaining: 40,
            last_trade_at: tradeTimestamp.toISOString(),
         });
      });

      it('returns is_active: false and seconds_remaining: 0 when cooldown expired', async () => {
         const tradeTimestamp = new Date('2026-10-17T20:00:00.000Z');
         mockPrisma.creatorProfile.findFirst.mockResolvedValue({
            id: 'key-1',
            cooldownLedgers: 10,
         });
         mockPrisma.trade.findFirst.mockResolvedValue({
            ledger: 100,
            timestamp: tradeTimestamp,
         });
         mockPrisma.indexedLedger.findUnique.mockResolvedValue({ ledger: 120 }); // expired

         const res = await supertest(app).get(pathUrl('key-1', WALLET));

         expect(res.status).toBe(200);
         expect(res.body.data).toEqual({
            is_active: false,
            seconds_remaining: 0,
            last_trade_at: tradeTimestamp.toISOString(),
         });
      });

      it('returns is_active: false, seconds_remaining: 0, and last_trade_at: null when no prior trade', async () => {
         mockPrisma.creatorProfile.findFirst.mockResolvedValue({
            id: 'key-1',
            cooldownLedgers: 10,
         });
         mockPrisma.trade.findFirst.mockResolvedValue(null);
         mockPrisma.indexedLedger.findUnique.mockResolvedValue({ ledger: 100 });

         const res = await supertest(app).get(pathUrl('key-1', WALLET));

         expect(res.status).toBe(200);
         expect(res.body.data).toEqual({
            is_active: false,
            seconds_remaining: 0,
            last_trade_at: null,
         });
      });

      it('returns cached response on second call within 200ms target', async () => {
         mockPrisma.creatorProfile.findFirst.mockResolvedValue({
            id: 'key-1',
            cooldownLedgers: 10,
         });
         mockPrisma.trade.findFirst.mockResolvedValue({
            ledger: 100,
            timestamp: new Date(),
         });
         mockPrisma.indexedLedger.findUnique.mockResolvedValue({ ledger: 102 });

         const start = Date.now();
         const res1 = await supertest(app).get(pathUrl('key-1', WALLET));
         expect(res1.status).toBe(200);

         // Second call should hit redis cache and not database
         mockPrisma.creatorProfile.findFirst.mockClear();
         mockPrisma.trade.findFirst.mockClear();

         const res2 = await supertest(app).get(pathUrl('key-1', WALLET));
         const duration = Date.now() - start;

         expect(res2.status).toBe(200);
         expect(mockPrisma.trade.findFirst).not.toHaveBeenCalled();
         expect(duration).toBeLessThan(500);
      });

      it('invalidates cache on invalidateCooldownCache call', async () => {
         const { invalidateCooldownCache } =
            await import('./key-cooldown.service');
         mockPrisma.creatorProfile.findFirst.mockResolvedValue({
            id: 'key-1',
            cooldownLedgers: 10,
         });
         mockPrisma.trade.findFirst.mockResolvedValue({
            ledger: 100,
            timestamp: new Date(),
         });
         mockPrisma.indexedLedger.findUnique.mockResolvedValue({ ledger: 102 });

         await supertest(app).get(pathUrl('key-1', WALLET));
         expect(redisStore.size).toBeGreaterThan(0);

         await invalidateCooldownCache('key-1', WALLET);
         expect(redisStore.size).toBe(0);
      });

      it('returns 400 when wallet is invalid in path parameter', async () => {
         const res = await supertest(app).get(
            pathUrl('key-1', 'not-a-stellar-address')
         );
         expect(res.status).toBe(400);
      });

      it('returns 404 when key is not found', async () => {
         mockPrisma.creatorProfile.findFirst.mockResolvedValue(null);
         const res = await supertest(app).get(
            pathUrl('non-existent-key', WALLET)
         );
         expect(res.status).toBe(404);
      });
   });
});
