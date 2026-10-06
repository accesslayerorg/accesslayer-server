// src/modules/keys/circuit-breaker.service.test.ts
const cacheStore = new Map<string, unknown>();

jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn(async (key: string) =>
      cacheStore.has(key) ? (cacheStore.get(key) as unknown) : null
   ),
   cacheSetJson: jest.fn(async (key: string, value: unknown) => {
      cacheStore.set(key, value);
   }),
}));

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      creatorProfile: { findFirst: jest.fn() },
      circuitBreakerTrip: {
         count: jest.fn(),
         findMany: jest.fn(),
         findFirst: jest.fn(),
      },
   },
}));

jest.mock('./circuit-breaker-contract', () => ({
   fetchCircuitBreakerMaxBpsFromContract: jest.fn(),
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
import { envConfig } from '../../config';
import { circuitBreakerConfigRedisKey } from '../../constants/redis.constants';
import { fetchCircuitBreakerMaxBpsFromContract } from './circuit-breaker-contract';
import {
   DEFAULT_CIRCUIT_BREAKER_MAX_BPS,
   getCircuitBreakerConfig,
   getCircuitBreakerState,
   KeyNotFoundError,
} from './circuit-breaker.service';

const mockPrisma = prisma as unknown as {
   creatorProfile: { findFirst: jest.Mock };
   circuitBreakerTrip: {
      count: jest.Mock;
      findMany: jest.Mock;
      findFirst: jest.Mock;
   };
};

const mockFetchContract = fetchCircuitBreakerMaxBpsFromContract as jest.Mock;

const KEY_ID = 'key-1';
const TRIPS = [
   {
      id: 'trip-2',
      actualBps: 2600,
      maxBps: 2500,
      ledger: 12,
      txHash: 'tx-2',
      eventIndex: 1,
      occurredAt: new Date('2026-09-28T11:00:00.000Z'),
   },
   {
      id: 'trip-1',
      actualBps: 1500,
      maxBps: 2500,
      ledger: 11,
      txHash: 'tx-1',
      eventIndex: 0,
      occurredAt: new Date('2026-09-28T10:00:00.000Z'),
   },
];

function primeCreator(circuitBreakerThreshold = 3000) {
   mockPrisma.creatorProfile.findFirst.mockResolvedValue({
      id: KEY_ID,
      circuitBreakerThreshold,
   });
}

beforeEach(() => {
   cacheStore.clear();
   jest.clearAllMocks();
   primeCreator();
   mockFetchContract.mockResolvedValue(2500);
   mockPrisma.circuitBreakerTrip.count.mockResolvedValue(TRIPS.length);
   mockPrisma.circuitBreakerTrip.findMany.mockResolvedValue(TRIPS);
   mockPrisma.circuitBreakerTrip.findFirst.mockResolvedValue(TRIPS[0]);
});

describe('circuit-breaker.service', () => {
   describe('getCircuitBreakerState', () => {
      it('returns the config, active flag and paginated trip history', async () => {
         const state = await getCircuitBreakerState(KEY_ID, {
            limit: 50,
            offset: 0,
         });

         expect(state.keyId).toBe(KEY_ID);
         expect(state.maxBps).toBe(2500);
         expect(state.config.source).toBe('contract');
         expect(state.active).toBe(true);
         expect(state.tripCount).toBe(2);
         expect(state.limit).toBe(50);
         expect(state.offset).toBe(0);
         expect(state.trips).toHaveLength(2);
         expect(state.trips[0]).toEqual(
            expect.objectContaining({
               id: 'trip-2',
               actualBps: 2600,
               occurredAt: '2026-09-28T11:00:00.000Z',
            })
         );
      });

      it('is inactive when the latest trip is below the threshold', async () => {
         mockPrisma.circuitBreakerTrip.findFirst.mockResolvedValue(TRIPS[1]);

         const state = await getCircuitBreakerState(KEY_ID, {
            limit: 50,
            offset: 0,
         });

         expect(state.maxBps).toBe(2500);
         expect(state.active).toBe(false);
      });

      it('passes the pagination window to the trip query', async () => {
         await getCircuitBreakerState(KEY_ID, { limit: 10, offset: 20 });

         expect(mockPrisma.circuitBreakerTrip.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ take: 10, skip: 20 })
         );
      });

      it('throws KeyNotFoundError for an unknown key', async () => {
         mockPrisma.creatorProfile.findFirst.mockResolvedValue(null);

         await expect(
            getCircuitBreakerState('missing', { limit: 50, offset: 0 })
         ).rejects.toThrow(KeyNotFoundError);
         expect(mockPrisma.circuitBreakerTrip.findMany).not.toHaveBeenCalled();
      });
   });

   describe('config caching', () => {
      it('fetches from the contract on a cache miss and caches for the TTL', async () => {
         const config = await getCircuitBreakerConfig(KEY_ID, 3000);

         expect(mockFetchContract).toHaveBeenCalledWith(KEY_ID);
         expect(config).toEqual(
            expect.objectContaining({ maxBps: 2500, source: 'contract' })
         );
         expect(cacheSetJson).toHaveBeenCalledWith(
            circuitBreakerConfigRedisKey(KEY_ID),
            expect.objectContaining({ maxBps: 2500, source: 'contract' }),
            envConfig.CIRCUIT_BREAKER_CONFIG_CACHE_TTL_SECONDS
         );
         expect(envConfig.CIRCUIT_BREAKER_CONFIG_CACHE_TTL_SECONDS).toBe(300);
      });

      it('reuses the cached config within the TTL instead of re-reading the contract', async () => {
         cacheStore.set(circuitBreakerConfigRedisKey(KEY_ID), {
            maxBps: 2000,
            source: 'contract',
            cachedAt: new Date().toISOString(),
         });

         const config = await getCircuitBreakerConfig(KEY_ID, 3000);

         expect(config.maxBps).toBe(2000);
         expect(mockFetchContract).not.toHaveBeenCalled();
      });

      it('refreshes the config from the contract after the cache expires', async () => {
         await getCircuitBreakerConfig(KEY_ID, 3000);
         expect(mockFetchContract).toHaveBeenCalledTimes(1);

         // Expiry evicts the key, so the next read is a miss again.
         cacheStore.delete(circuitBreakerConfigRedisKey(KEY_ID));

         const refreshed = await getCircuitBreakerConfig(KEY_ID, 3000);
         expect(mockFetchContract).toHaveBeenCalledTimes(2);
         expect(refreshed.maxBps).toBe(2500);
      });

      it('falls back to the indexed threshold when the contract read fails', async () => {
         mockFetchContract.mockResolvedValue(null);

         const config = await getCircuitBreakerConfig(KEY_ID, 3200);

         expect(config.maxBps).toBe(3200);
         expect(config.source).toBe('indexed');
      });

      it('uses the default threshold when the indexed value is absent', async () => {
         mockFetchContract.mockResolvedValue(null);
         mockPrisma.creatorProfile.findFirst.mockResolvedValue({
            id: KEY_ID,
            circuitBreakerThreshold: null,
         });

         const state = await getCircuitBreakerState(KEY_ID, {
            limit: 50,
            offset: 0,
         });

         expect(state.maxBps).toBe(DEFAULT_CIRCUIT_BREAKER_MAX_BPS);
      });
   });
});
