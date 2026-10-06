// src/modules/keys/key-twap.service.test.ts
const redisStore = new Map<string, unknown>();

jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn(async (key: string) =>
      redisStore.has(key) ? (redisStore.get(key) as unknown) : null
   ),
   cacheSetJson: jest.fn(async (key: string, value: unknown) => {
      redisStore.set(key, value);
   }),
}));

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      creatorProfile: { findFirst: jest.fn() },
      creatorPriceHistory: { findFirst: jest.fn(), findMany: jest.fn() },
   },
}));

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
   },
}));

import { prisma } from '../../utils/prisma.utils';
import { cacheSetJson } from '../../utils/redis.utils';
import {
   computeAndCacheTwap,
   computeDeltaPct,
   computeTwapFromSnapshots,
   getTwapPrice,
   KeyNotFoundError,
} from './key-twap.service';
import {
   TWAP_CACHE_TTL_SECONDS,
   TWAP_STALE_THRESHOLD_MS,
   twapRedisKey,
} from '../../constants/redis.constants';

const mockPrisma = prisma as unknown as {
   creatorProfile: { findFirst: jest.Mock };
   creatorPriceHistory: { findFirst: jest.Mock; findMany: jest.Mock };
};

function mockCreator(overrides: Record<string, unknown> = {}) {
   mockPrisma.creatorProfile.findFirst.mockResolvedValue({
      id: 'key-1',
      circulatingSupply: '10',
      creatorRoyaltyBuyBps: 0,
      ...overrides,
   });
}

describe('key-twap.service', () => {
   beforeEach(() => {
      redisStore.clear();
      jest.clearAllMocks();
   });

   describe('computeTwapFromSnapshots', () => {
      it('weights prices by time with a prior seed', () => {
         const now = new Date('2026-09-27T12:00:00.000Z').getTime();
         const start = now - 60 * 60 * 1000;
         // Seed 100 for first 30m, then 200 for last 30m => TWAP 150.
         const snapshots = [
            { timestamp: new Date(start + 30 * 60 * 1000), price: 200n },
         ];
         expect(computeTwapFromSnapshots(100n, snapshots, start, now)).toBe(
            150n
         );
      });

      it('fills the leading gap with the first price when no prior exists', () => {
         const now = new Date('2026-09-27T12:00:00.000Z').getTime();
         const start = now - 60 * 60 * 1000;
         const snapshots = [
            { timestamp: new Date(start + 30 * 60 * 1000), price: 200n },
         ];
         // First price fills [start, t1), then 200 to now => 200.
         expect(computeTwapFromSnapshots(null, snapshots, start, now)).toBe(
            200n
         );
      });

      it('returns the seed price when no in-window snapshots exist', () => {
         const now = Date.now();
         const start = now - 60 * 60 * 1000;
         expect(computeTwapFromSnapshots(123n, [], start, now)).toBe(123n);
      });

      it('returns null when there is no price information', () => {
         const now = Date.now();
         const start = now - 60 * 60 * 1000;
         expect(computeTwapFromSnapshots(null, [], start, now)).toBeNull();
      });
   });

   describe('computeDeltaPct', () => {
      it('computes ((spot - twap) / twap) * 100', () => {
         expect(computeDeltaPct(110n, 100n)).toBe(10);
         expect(computeDeltaPct(90n, 100n)).toBe(-10);
      });

      it('returns null when TWAP is zero (division-by-zero guard)', () => {
         expect(computeDeltaPct(100n, 0n)).toBeNull();
      });
   });

   describe('computeAndCacheTwap', () => {
      it('falls back to spot with delta 0 when the key has 0 snapshots', async () => {
         mockCreator();
         mockPrisma.creatorPriceHistory.findFirst.mockResolvedValue(null);
         mockPrisma.creatorPriceHistory.findMany.mockResolvedValue([]);

         const result = await computeAndCacheTwap('key-1', '1h');

         expect(result.twap).toBe(result.spotPrice);
         expect(result.deltaPct).toBe(0);
         expect(result.stale).toBe(false);
         expect(cacheSetJson).toHaveBeenCalledWith(
            twapRedisKey('key-1', '1h'),
            expect.objectContaining({ keyId: 'key-1', window: '1h' }),
            TWAP_CACHE_TTL_SECONDS['1h']
         );
      });

      it('seeds carry-forward from the snapshot prior to the window start', async () => {
         mockCreator();
         const now = new Date('2026-09-27T12:00:00.000Z');
         const windowStart = new Date(now.getTime() - 60 * 60 * 1000);
         mockPrisma.creatorPriceHistory.findFirst.mockResolvedValue({
            price: 100n,
            recordedAt: new Date(windowStart.getTime() - 1000),
         });
         mockPrisma.creatorPriceHistory.findMany.mockResolvedValue([
            {
               price: 200n,
               recordedAt: new Date(windowStart.getTime() + 30 * 60 * 1000),
            },
         ]);

         const result = await computeAndCacheTwap('key-1', '1h', now);

         expect(result.twap).toBe('150');
      });

      it('throws KeyNotFoundError for an unknown key', async () => {
         mockPrisma.creatorProfile.findFirst.mockResolvedValue(null);
         await expect(computeAndCacheTwap('missing', '1h')).rejects.toThrow(
            KeyNotFoundError
         );
      });
   });

   describe('getTwapPrice read-through', () => {
      it('computes on a cold cache and caches with window TTL', async () => {
         mockCreator();
         mockPrisma.creatorPriceHistory.findFirst.mockResolvedValue(null);
         mockPrisma.creatorPriceHistory.findMany.mockResolvedValue([]);

         const result = await getTwapPrice('key-1', '4h');

         expect(result.window).toBe('4h');
         expect(redisStore.has(twapRedisKey('key-1', '4h'))).toBe(true);
      });

      it('serves cache hits without hitting the history table', async () => {
         mockCreator();
         const cached = {
            keyId: 'key-1',
            window: '1h' as const,
            twap: '100',
            spotPrice: '110',
            deltaPct: 10,
            computedAt: new Date().toISOString(),
            stale: false,
         };
         redisStore.set(twapRedisKey('key-1', '1h'), cached);

         const result = await getTwapPrice('key-1', '1h');

         expect(result.twap).toBe('100');
         expect(result.stale).toBe(false);
         expect(mockPrisma.creatorPriceHistory.findMany).not.toHaveBeenCalled();
      });

      it('marks stale true when computedAt is older than 10 minutes', async () => {
         mockCreator();
         expect(TWAP_STALE_THRESHOLD_MS).toBe(10 * 60 * 1000);
         const cached = {
            keyId: 'key-1',
            window: '24h' as const,
            twap: '100',
            spotPrice: '100',
            deltaPct: 0,
            computedAt: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
            stale: false,
         };
         redisStore.set(twapRedisKey('key-1', '24h'), cached);

         const result = await getTwapPrice('key-1', '24h');

         expect(result.stale).toBe(true);
      });
   });
});
