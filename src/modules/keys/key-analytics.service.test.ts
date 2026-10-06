// Unit tests: key + platform trade analytics (#916)
// - trade_count / unique_traders / total_volume computed from Trade rows
// - from/to window is applied to Trade.timestamp
// - results cached 60s per key/window; invalidated by new trade events
// - platform aggregate totals across all keys

const mockCache = new Map<string, string>();
const mockTtls = new Map<string, number>();

jest.mock('../../utils/redis.utils', () => {
   const toRegex = (pattern: string) =>
      new RegExp(
         '^' +
            pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') +
            '$'
      );
   return {
      cacheGetJson: jest.fn(async (key: string) => {
         const raw = mockCache.get(key);
         return raw === undefined ? null : JSON.parse(raw);
      }),
      cacheSetJson: jest.fn(async (key: string, value: unknown, ttl: number) => {
         mockCache.set(key, JSON.stringify(value));
         mockTtls.set(key, ttl);
      }),
      cacheInvalidate: jest.fn(async (...patterns: string[]) => {
         for (const pattern of patterns) {
            const re = toRegex(pattern);
            for (const key of [...mockCache.keys()]) {
               if (re.test(key)) mockCache.delete(key);
            }
         }
      }),
   };
});

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      creatorProfile: { findUnique: jest.fn() },
      trade: { findMany: jest.fn() },
   },
}));

import { prisma } from '../../utils/prisma.utils';
import { KeyNotFoundError } from './key-fees.service';
import {
   aggregateTrades,
   analyticsWindowQuerySchema,
   getKeyAnalytics,
   getKeyAnalyticsCacheKey,
   getPlatformAnalytics,
   invalidateKeyAnalyticsCache,
   KEY_ANALYTICS_CACHE_TTL_SECONDS,
} from './key-analytics.service';
import { processTradeEvent } from '../indexer/trade-indexer.service';

const creatorFindUnique = prisma.creatorProfile.findUnique as jest.Mock;
const tradeFindMany = prisma.trade.findMany as jest.Mock;

type Row = {
   buyer: string;
   creatorId: string;
   price: string;
   quantity: string;
   timestamp: Date;
};

const TRADES: Row[] = [
   { buyer: 'GA', creatorId: 'key-1', price: '100', quantity: '2', timestamp: new Date('2026-09-01T00:00:00Z') },
   { buyer: 'GB', creatorId: 'key-1', price: '150', quantity: '1', timestamp: new Date('2026-09-10T00:00:00Z') },
   { buyer: 'GA', creatorId: 'key-1', price: '200', quantity: '3', timestamp: new Date('2026-09-20T00:00:00Z') },
   { buyer: 'GC', creatorId: 'key-2', price: '50', quantity: '4', timestamp: new Date('2026-09-15T00:00:00Z') },
   { buyer: 'GA', creatorId: 'key-2', price: '10', quantity: '1', timestamp: new Date('2026-09-25T00:00:00Z') },
];

/** Emulate Prisma's where { creatorId, timestamp: { gte, lte } } over TRADES. */
function applyWhere(where: any = {}): Row[] {
   return TRADES.filter(t => {
      if (where.creatorId && t.creatorId !== where.creatorId) return false;
      if (where.timestamp?.gte && t.timestamp < where.timestamp.gte) return false;
      if (where.timestamp?.lte && t.timestamp > where.timestamp.lte) return false;
      return true;
   });
}

beforeEach(() => {
   jest.clearAllMocks();
   mockCache.clear();
   mockTtls.clear();
   creatorFindUnique.mockImplementation(async ({ where }: any) =>
      ['key-1', 'key-2', 'key-empty'].includes(where.id) ? { id: where.id } : null
   );
   tradeFindMany.mockImplementation(async ({ where }: any) => applyWhere(where));
});

describe('aggregateTrades', () => {
   it('returns zeros for no trades', () => {
      expect(aggregateTrades([])).toEqual({
         trade_count: 0,
         unique_traders: 0,
         total_volume: '0',
      });
   });

   it('sums price * quantity without float precision loss', () => {
      const result = aggregateTrades([
         { buyer: 'GA', price: '9007199254740993', quantity: '3' },
      ]);
      expect(result.total_volume).toBe('27021597764222979');
   });
});

describe('getKeyAnalytics', () => {
   it('returns correct trade_count, unique_traders and total_volume', async () => {
      const result = await getKeyAnalytics('key-1');

      expect(result).toEqual({
         keyId: 'key-1',
         trade_count: 3,
         unique_traders: 2, // GA traded twice
         total_volume: String(100 * 2 + 150 * 1 + 200 * 3),
         from: null,
         to: null,
      });
   });

   it('returns zeros for a key with no trades', async () => {
      const result = await getKeyAnalytics('key-empty');
      expect(result).toMatchObject({
         trade_count: 0,
         unique_traders: 0,
         total_volume: '0',
      });
   });

   it('throws KeyNotFoundError for an unknown key', async () => {
      await expect(getKeyAnalytics('missing')).rejects.toBeInstanceOf(
         KeyNotFoundError
      );
      expect(tradeFindMany).not.toHaveBeenCalled();
   });

   it('applies the from/to window to trade timestamps (inclusive)', async () => {
      const from = new Date('2026-09-10T00:00:00Z');
      const to = new Date('2026-09-20T00:00:00Z');

      const result = await getKeyAnalytics('key-1', { from, to });

      expect(tradeFindMany).toHaveBeenCalledWith(
         expect.objectContaining({
            where: { creatorId: 'key-1', timestamp: { gte: from, lte: to } },
         })
      );
      expect(result).toMatchObject({
         trade_count: 2,
         unique_traders: 2,
         total_volume: String(150 + 600),
         from: from.toISOString(),
         to: to.toISOString(),
      });
   });

   it('supports an open-ended window with only from', async () => {
      const from = new Date('2026-09-15T00:00:00Z');
      const result = await getKeyAnalytics('key-1', { from });

      expect(tradeFindMany).toHaveBeenCalledWith(
         expect.objectContaining({
            where: { creatorId: 'key-1', timestamp: { gte: from } },
         })
      );
      expect(result).toMatchObject({ trade_count: 1, to: null });
   });

   it('caches per key and window with a 60s TTL', async () => {
      await getKeyAnalytics('key-1');
      const key = getKeyAnalyticsCacheKey('key-1');
      expect(mockTtls.get(key)).toBe(60);
      expect(KEY_ANALYTICS_CACHE_TTL_SECONDS).toBe(60);

      // different window → separate cache entry
      await getKeyAnalytics('key-1', { from: new Date('2026-09-15T00:00:00Z') });
      expect(tradeFindMany).toHaveBeenCalledTimes(2);
      expect(mockCache.size).toBe(2);
   });

   it('serves repeat requests from cache without touching the database, under 150ms', async () => {
      const first = await getKeyAnalytics('key-1');
      jest.clearAllMocks();

      const start = performance.now();
      const second = await getKeyAnalytics('key-1');
      const elapsed = performance.now() - start;

      expect(second).toEqual(first);
      expect(creatorFindUnique).not.toHaveBeenCalled();
      expect(tradeFindMany).not.toHaveBeenCalled();
      expect(elapsed).toBeLessThan(150);
   });
});

describe('cache invalidation', () => {
   it('invalidateKeyAnalyticsCache drops every window for the key and platform, but not other keys', async () => {
      await getKeyAnalytics('key-1');
      await getKeyAnalytics('key-1', { from: new Date('2026-09-15T00:00:00Z') });
      await getKeyAnalytics('key-2');
      await getPlatformAnalytics();

      await invalidateKeyAnalyticsCache('key-1');

      const remaining = [...mockCache.keys()];
      expect(remaining).toEqual([getKeyAnalyticsCacheKey('key-2')]);
   });

   it('a new trade event invalidates cached analytics so the next read is fresh', async () => {
      const before = await getKeyAnalytics('key-1');
      expect(before.trade_count).toBe(3);

      const newTrade: Row = {
         buyer: 'GD',
         creatorId: 'key-1',
         price: '300',
         quantity: '1',
         timestamp: new Date('2026-09-24T00:00:00Z'),
      };
      const db = {
         trade: {
            findUnique: jest.fn().mockResolvedValue(null),
            create: jest.fn(async () => {
               TRADES.push(newTrade);
            }),
         },
      };

      try {
         const processed = await processTradeEvent(
            {
               buyer: newTrade.buyer,
               creator_id: newTrade.creatorId,
               quantity: newTrade.quantity,
               price: newTrade.price,
               ledger: 999,
               tx_hash: 'tx-new',
               timestamp: newTrade.timestamp.toISOString(),
            },
            db
         );
         expect(processed).toBe(true);

         const after = await getKeyAnalytics('key-1');
         expect(after).toMatchObject({
            trade_count: 4,
            unique_traders: 3,
            total_volume: String(950 + 300),
         });
      } finally {
         TRADES.splice(TRADES.indexOf(newTrade), 1);
      }
   });
});

describe('getPlatformAnalytics', () => {
   it('returns correct totals across all keys', async () => {
      const result = await getPlatformAnalytics();

      expect(result).toEqual({
         trade_count: 5,
         unique_traders: 3, // GA, GB, GC
         total_volume: String(200 + 150 + 600 + 200 + 10),
         key_count: 2,
         from: null,
         to: null,
      });
   });

   it('applies the time window to platform totals', async () => {
      const from = new Date('2026-09-15T00:00:00Z');
      const result = await getPlatformAnalytics({ from });

      expect(result).toMatchObject({
         trade_count: 3,
         unique_traders: 2, // GA, GC
         total_volume: String(600 + 200 + 10),
         key_count: 2,
      });
   });

   it('is served from cache on repeat requests', async () => {
      await getPlatformAnalytics();
      await getPlatformAnalytics();
      expect(tradeFindMany).toHaveBeenCalledTimes(1);
   });
});

describe('analyticsWindowQuerySchema', () => {
   it('accepts an empty query', () => {
      expect(analyticsWindowQuerySchema.parse({})).toEqual({
         from: undefined,
         to: undefined,
      });
   });

   it('parses ISO datetimes into Dates', () => {
      const result = analyticsWindowQuerySchema.parse({
         from: '2026-09-01T00:00:00Z',
         to: '2026-09-30T00:00:00Z',
      });
      expect(result.from).toEqual(new Date('2026-09-01T00:00:00Z'));
      expect(result.to).toEqual(new Date('2026-09-30T00:00:00Z'));
   });

   it('rejects non-ISO values', () => {
      expect(analyticsWindowQuerySchema.safeParse({ from: 'yesterday' }).success).toBe(false);
   });

   it('rejects from after to', () => {
      expect(
         analyticsWindowQuerySchema.safeParse({
            from: '2026-09-30T00:00:00Z',
            to: '2026-09-01T00:00:00Z',
         }).success
      ).toBe(false);
   });
});
