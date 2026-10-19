const redisStore = new Map<string, string>();

jest.mock('../../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn(async (key: string) => {
      const v = redisStore.get(key);
      return v ? JSON.parse(v) : null;
   }),
   cacheSetJson: jest.fn(async (key: string, value: unknown) => {
      redisStore.set(key, JSON.stringify(value));
   }),
   cacheInvalidate: jest.fn(async (...keys: string[]) => {
      for (const k of keys) redisStore.delete(k);
   }),
}));

jest.mock('../../../utils/prisma.utils', () => ({
   prisma: {
      creatorProfile: { findFirst: jest.fn(), findUnique: jest.fn() },
      creatorPriceHistory: { findFirst: jest.fn(), findMany: jest.fn() },
      creatorPriceSnapshot: { findUnique: jest.fn() },
      twapSnapshot: { findFirst: jest.fn(), create: jest.fn() },
   },
}));

jest.mock('../../../utils/indexer-dlq.utils', () => ({
   moveToDLQ: jest.fn().mockResolvedValue({}),
}));

jest.mock('../../../utils/logger.utils', () => ({
   logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      isLevelEnabled: jest.fn().mockReturnValue(false),
   },
}));

import request from 'supertest';
import express from 'express';
import keysRouter from '../keys.routes';
import { prisma } from '../../../utils/prisma.utils';
import { cacheSetJson } from '../../../utils/redis.utils';
import { envConfig } from '../../../config';
import { processTwapUpdatedEvent } from '../../indexer/twap-indexer.service';

const app = express();
app.use(express.json());
app.use('/api/v1/keys', keysRouter);

const db = prisma as any;
const MIN = envConfig.TWAP_MIN_OBSERVATIONS;

const KEYS: Record<string, string> = { 'key-1': 'key-1', 'key-2': 'key-2', alice: 'key-1' };

function row(overrides: Record<string, unknown> = {}) {
   return {
      twapPrice: 12500000n,
      observationCount: MIN + 2,
      computedAt: new Date('2026-10-18T10:00:00.000Z'),
      ...overrides,
   };
}

const get = (key: string, query = '') =>
   request(app).get(`/api/v1/keys/${key}/twap${query}`);

describe('GET /api/v1/keys/:keyId/twap (#1082)', () => {
   beforeEach(() => {
      redisStore.clear();
      jest.clearAllMocks();
      db.creatorProfile.findFirst.mockImplementation(async ({ where }: any) => {
         const wanted: string[] = where.OR.flatMap((c: any) => Object.values(c));
         const hit = wanted.find(w => KEYS[w]);
         return hit ? { id: KEYS[hit] } : null;
      });
      db.twapSnapshot.findFirst.mockResolvedValue(row());
      db.twapSnapshot.create.mockResolvedValue({});
   });

   describe('windows', () => {
      it.each([
         ['1h', 11000000n],
         ['4h', 12000000n],
         ['24h', 13000000n],
      ])('returns the correct TWAP for window=%s', async (window, price) => {
         db.twapSnapshot.findFirst.mockImplementation(async ({ where }: any) =>
            where.window === window ? row({ twapPrice: price }) : null
         );

         const res = await get('key-1', `?window=${window}`);

         expect(res.status).toBe(200);
         expect(res.body.success).toBe(true);
         expect(res.body.data).toEqual({
            twap_price: price.toString(),
            window,
            computed_at: '2026-10-18T10:00:00.000Z',
         });
         expect(db.twapSnapshot.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
               where: { creatorId: 'key-1', window },
            })
         );
      });

      it('returns different values for different windows of the same key', async () => {
         db.twapSnapshot.findFirst.mockImplementation(async ({ where }: any) =>
            row({ twapPrice: where.window === '1h' ? 1n : where.window === '4h' ? 4n : 24n })
         );
         const [a, b, c] = await Promise.all([
            get('key-1', '?window=1h'),
            get('key-1', '?window=4h'),
            get('key-1', '?window=24h'),
         ]);
         expect([a, b, c].map(r => r.body.data.twap_price)).toEqual(['1', '4', '24']);
      });

      it('selects the latest observation by computedAt, then ledger, then eventIndex', async () => {
         await get('key-1', '?window=1h');
         expect(db.twapSnapshot.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
               orderBy: [
                  { computedAt: 'desc' },
                  { ledger: 'desc' },
                  { eventIndex: 'desc' },
               ],
            })
         );
      });

      it('keeps stroop precision beyond Number.MAX_SAFE_INTEGER', async () => {
         db.twapSnapshot.findFirst.mockResolvedValue(
            row({ twapPrice: 9007199254740993n })
         );
         const res = await get('key-1', '?window=1h');
         expect(res.body.data.twap_price).toBe('9007199254740993');
      });
   });

   describe('validation', () => {
      it.each([['', 'missing'], ['?window=7d', 'unsupported 7d'], ['?window=2h', 'unknown'], ['?window=', 'empty']])(
         'returns 422 for %s window (%s)',
         async query => {
            const res = await get('key-1', query);
            expect(res.status).toBe(422);
            expect(res.body.success).toBe(false);
            expect(db.twapSnapshot.findFirst).not.toHaveBeenCalled();
         }
      );

      it('returns 404 for an unknown key', async () => {
         const res = await get('nope', '?window=1h');
         expect(res.status).toBe(404);
         expect(db.twapSnapshot.findFirst).not.toHaveBeenCalled();
      });

      it('resolves a handle to the canonical key id', async () => {
         const res = await get('alice', '?window=1h');
         expect(res.status).toBe(200);
         expect(db.twapSnapshot.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({ where: { creatorId: 'key-1', window: '1h' } })
         );
      });
   });

   describe('TWAPInvalid', () => {
      it('returns TWAPInvalid when observations are below the minimum', async () => {
         db.twapSnapshot.findFirst.mockResolvedValue(row({ observationCount: MIN - 1 }));

         const res = await get('key-1', '?window=1h');

         expect(res.status).toBe(422);
         expect(res.body.success).toBe(false);
         expect(res.body.error.code).toBe('TWAPInvalid');
         expect(res.body.data).toBeUndefined();
         expect(JSON.stringify(res.body)).not.toContain('twap_price');
      });

      it('returns a price when observations equal the minimum exactly', async () => {
         db.twapSnapshot.findFirst.mockResolvedValue(row({ observationCount: MIN }));
         const res = await get('key-1', '?window=1h');
         expect(res.status).toBe(200);
      });

      it('returns TWAPInvalid when no snapshot has been indexed yet', async () => {
         db.twapSnapshot.findFirst.mockResolvedValue(null);
         const res = await get('key-1', '?window=24h');
         expect(res.status).toBe(422);
         expect(res.body.error.code).toBe('TWAPInvalid');
      });

      it('applies the threshold per window', async () => {
         db.twapSnapshot.findFirst.mockImplementation(async ({ where }: any) =>
            row({ observationCount: where.window === '24h' ? MIN + 10 : 0 })
         );
         const [h1, h24] = await Promise.all([
            get('key-1', '?window=1h'),
            get('key-1', '?window=24h'),
         ]);
         expect(h1.status).toBe(422);
         expect(h24.status).toBe(200);
      });
   });

   describe('caching', () => {
      it('caches with a 60s TTL and serves repeats without touching the table', async () => {
         await get('key-1', '?window=1h');
         await get('key-1', '?window=1h');
         await get('key-1', '?window=1h');

         expect(db.twapSnapshot.findFirst).toHaveBeenCalledTimes(1);
         expect(cacheSetJson).toHaveBeenCalledWith(
            'twap:snapshot:key-1:1h',
            expect.objectContaining({ valid: true }),
            60
         );
      });

      it('caches TWAPInvalid results too, with the same TTL', async () => {
         db.twapSnapshot.findFirst.mockResolvedValue(null);
         await get('key-1', '?window=1h');
         const second = await get('key-1', '?window=1h');

         expect(second.status).toBe(422);
         expect(db.twapSnapshot.findFirst).toHaveBeenCalledTimes(1);
         expect(cacheSetJson).toHaveBeenCalledWith(
            'twap:snapshot:key-1:1h',
            expect.objectContaining({ valid: false }),
            60
         );
      });

      it('caches each window independently', async () => {
         await get('key-1', '?window=1h');
         await get('key-1', '?window=4h');
         expect(db.twapSnapshot.findFirst).toHaveBeenCalledTimes(2);
      });

      it('serves cached requests well under 150ms', async () => {
         await get('key-1', '?window=1h'); // warm
         const samples: number[] = [];
         for (let i = 0; i < 20; i++) {
            const t0 = process.hrtime.bigint();
            const res = await get('key-1', '?window=1h');
            samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
            expect(res.status).toBe(200);
         }
         samples.sort((a, b) => a - b);
         const p95 = samples[Math.floor(samples.length * 0.95) - 1];
         expect(p95).toBeLessThan(150);
      });
   });

   describe('cache invalidation on a new TWAPUpdated event', () => {
      const event = (overrides: Record<string, unknown> = {}) => ({
         txHash: 'tx-new',
         eventIndex: 0,
         eventType: 'TWAP_UPDATED',
         ledger: 2000,
         creatorId: 'key-1',
         window: '1h',
         twapPrice: '99000000',
         observationCount: MIN + 1,
         computedAt: '2026-10-18T11:00:00.000Z',
         ...overrides,
      });

      it('serves the new value on the very next request after the event', async () => {
         const before = await get('key-1', '?window=1h');
         expect(before.body.data.twap_price).toBe('12500000');

         // The new event lands in the table, then the indexer invalidates.
         db.twapSnapshot.findFirst.mockResolvedValue(
            row({ twapPrice: 99000000n, computedAt: new Date('2026-10-18T11:00:00.000Z') })
         );
         await processTwapUpdatedEvent(event());

         const after = await get('key-1', '?window=1h');
         expect(after.body.data.twap_price).toBe('99000000');
         expect(after.body.data.computed_at).toBe('2026-10-18T11:00:00.000Z');
      });

      it('invalidates only the affected key', async () => {
         await get('key-1', '?window=1h');
         await get('key-2', '?window=1h');
         expect(db.twapSnapshot.findFirst).toHaveBeenCalledTimes(2);

         await processTwapUpdatedEvent(event({ creatorId: 'key-1' }));

         // key-2 stays cached: no further table read.
         await get('key-2', '?window=1h');
         expect(db.twapSnapshot.findFirst).toHaveBeenCalledTimes(2);

         // key-1 was invalidated: it reads the table again.
         await get('key-1', '?window=1h');
         expect(db.twapSnapshot.findFirst).toHaveBeenCalledTimes(3);
      });

      it('invalidates every window of the affected key', async () => {
         for (const w of ['1h', '4h', '24h']) await get('key-1', `?window=${w}`);
         expect(db.twapSnapshot.findFirst).toHaveBeenCalledTimes(3);

         await processTwapUpdatedEvent(event({ window: '4h' }));

         for (const w of ['1h', '4h', '24h']) await get('key-1', `?window=${w}`);
         expect(db.twapSnapshot.findFirst).toHaveBeenCalledTimes(6);
      });

      it('invalidates a handle-addressed cache entry (cached under the id)', async () => {
         await get('alice', '?window=1h');
         await processTwapUpdatedEvent(event({ creatorId: 'key-1' }));
         await get('alice', '?window=1h');
         expect(db.twapSnapshot.findFirst).toHaveBeenCalledTimes(2);
      });

      it('replaces a cached TWAPInvalid once enough observations arrive', async () => {
         db.twapSnapshot.findFirst.mockResolvedValue(row({ observationCount: 1 }));
         expect((await get('key-1', '?window=1h')).status).toBe(422);

         db.twapSnapshot.findFirst.mockResolvedValue(row({ observationCount: MIN }));
         await processTwapUpdatedEvent(event({ observationCount: MIN }));

         expect((await get('key-1', '?window=1h')).status).toBe(200);
      });
   });
});
