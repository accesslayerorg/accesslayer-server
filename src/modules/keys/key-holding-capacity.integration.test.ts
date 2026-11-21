// Integration test: GET /api/v1/keys/:keyId/holding-capacity (#913)

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
}));

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      creatorProfile: { findFirst: jest.fn() },
      keyOwnership: { findUnique: jest.fn() },
   },
}));

const mockPrisma = prisma as unknown as {
   creatorProfile: { findFirst: jest.Mock };
   keyOwnership: { findUnique: jest.Mock };
};

const WALLET = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
const url = (keyId: string, wallet?: string, quantity?: number) => {
   const params = new URLSearchParams();
   if (wallet) params.set('wallet', wallet);
   if (quantity !== undefined) params.set('quantity', String(quantity));
   const qs = params.toString();
   return `/api/v1/keys/${keyId}/holding-capacity${qs ? `?${qs}` : ''}`;
};

describe('GET /api/v1/keys/:keyId/holding-capacity', () => {
   beforeEach(() => {
      redisStore.clear();
      jest.clearAllMocks();
   });

   function mockKeyWithHolding() {
      mockPrisma.creatorProfile.findFirst.mockResolvedValue({
         id: 'key-1',
         holderCapBps: 2500,
         supplyCap: 1000,
         circulatingSupply: '400',
      });
      mockPrisma.keyOwnership.findUnique.mockResolvedValue({ balance: '100' });
   }

   it('returns capacity without authentication', async () => {
      mockKeyWithHolding();

      const res = await supertest(app).get(url('key-1', WALLET));

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
         keyId: 'key-1',
         wallet: WALLET,
         current_holding: 100,
         cap: 250,
         remaining_capacity: 150,
         cap_percentage: 40,
         allowed: true,
      });
   });

   it('serves a cached response in under 150ms without hitting the DB', async () => {
      mockKeyWithHolding();
      await supertest(app).get(url('key-1', WALLET));
      jest.clearAllMocks();

      const start = Date.now();
      const res = await supertest(app).get(url('key-1', WALLET));
      const elapsed = Date.now() - start;

      expect(res.status).toBe(200);
      expect(res.body.data.cap).toBe(250);
      expect(elapsed).toBeLessThan(150);
      expect(mockPrisma.creatorProfile.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.keyOwnership.findUnique).not.toHaveBeenCalled();
   });

   it('returns 400 when wallet is missing', async () => {
      const res = await supertest(app).get(url('key-1'));
      expect(res.status).toBe(400);
      expect(mockPrisma.creatorProfile.findFirst).not.toHaveBeenCalled();
   });

   it('returns 400 when wallet is not a Stellar address', async () => {
      const res = await supertest(app).get(url('key-1', 'not-a-wallet'));
      expect(res.status).toBe(400);
   });

   it('returns 404 for an unknown key', async () => {
      mockPrisma.creatorProfile.findFirst.mockResolvedValue(null);

      const res = await supertest(app).get(url('missing', WALLET));
      expect(res.status).toBe(404);
   });

   // ── quantity / allowed (#913) ──────────────────────────────

   describe('quantity validation', () => {
      it('allowed=true when quantity fits within remaining capacity', async () => {
         mockKeyWithHolding(); // cap=250, holding=100, remaining=150

         const res = await supertest(app).get(url('key-1', WALLET, 100));

         expect(res.status).toBe(200);
         expect(res.body.data.allowed).toBe(true);
         expect(res.body.data.remaining_capacity).toBe(150);
         expect(res.body.data.current_holding).toBe(100);
      });

      it('allowed=true when quantity exactly equals remaining capacity', async () => {
         mockKeyWithHolding(); // cap=250, holding=100, remaining=150

         const res = await supertest(app).get(url('key-1', WALLET, 150));

         expect(res.status).toBe(200);
         expect(res.body.data.allowed).toBe(true);
      });

      it('allowed=false when quantity exceeds remaining capacity', async () => {
         mockKeyWithHolding(); // cap=250, holding=100, remaining=150

         const res = await supertest(app).get(url('key-1', WALLET, 151));

         expect(res.status).toBe(200);
         expect(res.body.data.allowed).toBe(false);
         expect(res.body.data.remaining_capacity).toBe(150);
      });

      it('allowed=true when quantity defaults to 0', async () => {
         mockKeyWithHolding();

         const res = await supertest(app).get(url('key-1', WALLET));

         expect(res.status).toBe(200);
         expect(res.body.data.allowed).toBe(true);
      });

      it('allowed=false when holding already at cap and quantity > 0', async () => {
         mockPrisma.creatorProfile.findFirst.mockResolvedValue({
            id: 'key-1',
            holderCapBps: 2500,
            supplyCap: 1000,
            circulatingSupply: '400',
         });
         mockPrisma.keyOwnership.findUnique.mockResolvedValue({
            balance: '250',
         });

         const res = await supertest(app).get(url('key-1', WALLET, 1));

         expect(res.status).toBe(200);
         expect(res.body.data.allowed).toBe(false);
         expect(res.body.data.remaining_capacity).toBe(0);
      });

      it('returns 400 for negative quantity', async () => {
         const res = await supertest(app).get(url('key-1', WALLET, -1));

         expect(res.status).toBe(400);
      });

      it('returns 400 for non-integer quantity', async () => {
         const res = await supertest(app).get(url('key-1', WALLET, 1.5));

         expect(res.status).toBe(400);
      });

      it('returns 400 for quantity exceeding 1,000,000', async () => {
         const res = await supertest(app).get(url('key-1', WALLET, 1_000_001));

         expect(res.status).toBe(400);
      });
   });
});
