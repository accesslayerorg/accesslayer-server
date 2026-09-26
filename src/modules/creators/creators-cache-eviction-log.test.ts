import {
   getCachedCreatorList,
   setCachedCreatorList,
   resetCreatorListCache,
} from './creators.cache';
import { logger } from '../../utils/logger.utils';

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      isLevelEnabled: jest.fn().mockReturnValue(true),
   },
}));

jest.mock('../../constants/creator-public-cache.constants', () => ({
   CREATOR_PUBLIC_ROUTE_CACHE_MAX_AGE_SECONDS: { publicRead: 60 },
}));

const mockLogger = logger as unknown as {
   debug: jest.Mock;
};

const BASE_QUERY = {
   limit: 20,
   offset: 0,
   sort: 'createdAt' as const,
   order: 'desc' as const,
   include: [] as never[],
};

function findEvictionCalls(): Record<string, unknown>[] {
   return mockLogger.debug.mock.calls
      .map((args: unknown[]) => args[0] as Record<string, unknown>)
      .filter(
         (obj: Record<string, unknown>) =>
            obj.event === 'creator_list_cache_eviction'
      );
}

describe('cache eviction structured log (#737)', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      resetCreatorListCache();
   });

   describe('TTL expiry', () => {
      it('emits a debug log with reason ttl_expired when a stale entry is read', () => {
         setCachedCreatorList(BASE_QUERY as any, [], 0);

         jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000);

         getCachedCreatorList(BASE_QUERY as any);

         const evictions = findEvictionCalls();
         const ttlEviction = evictions.find(e => e.reason === 'ttl_expired');

         expect(ttlEviction).toBeDefined();
         expect(ttlEviction).toHaveProperty('cache_key');
         expect(ttlEviction).toHaveProperty('reason', 'ttl_expired');
         expect(ttlEviction).toHaveProperty('cache_size_after');
         expect(ttlEviction).toHaveProperty('evicted_at');

         jest.restoreAllMocks();
      });

      it('cache_size_after reflects the size after eviction', () => {
         setCachedCreatorList(BASE_QUERY as any, [], 0);

         jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000);

         getCachedCreatorList(BASE_QUERY as any);

         const evictions = findEvictionCalls();
         const ttlEviction = evictions.find(e => e.reason === 'ttl_expired');

         expect(ttlEviction!.cache_size_after).toBe(0);

         jest.restoreAllMocks();
      });

      it('evicted_at is a valid ISO 8601 timestamp', () => {
         setCachedCreatorList(BASE_QUERY as any, [], 0);

         jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000);

         getCachedCreatorList(BASE_QUERY as any);

         const evictions = findEvictionCalls();
         const ttlEviction = evictions.find(e => e.reason === 'ttl_expired');
         const parsed = new Date(ttlEviction!.evicted_at as string);

         expect(parsed.toISOString()).toBe(ttlEviction!.evicted_at);

         jest.restoreAllMocks();
      });

      it('log level is debug', () => {
         setCachedCreatorList(BASE_QUERY as any, [], 0);

         jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000);

         getCachedCreatorList(BASE_QUERY as any);

         const evictions = findEvictionCalls();

         expect(evictions.length).toBeGreaterThanOrEqual(1);
         expect(mockLogger.debug).toHaveBeenCalled();

         jest.restoreAllMocks();
      });
   });

   describe('capacity overflow', () => {
      it('emits a debug log with reason capacity_overflow when the cache exceeds max entries', () => {
         for (let i = 0; i < 252; i++) {
            const query = { ...BASE_QUERY, offset: i };
            setCachedCreatorList(query as any, [], 0);
         }

         const evictions = findEvictionCalls();
         const overflowEviction = evictions.find(
            e => e.reason === 'capacity_overflow'
         );

         expect(overflowEviction).toBeDefined();
         expect(overflowEviction).toHaveProperty('cache_key');
         expect(overflowEviction).toHaveProperty('reason', 'capacity_overflow');
         expect(overflowEviction).toHaveProperty('cache_size_after');
         expect(overflowEviction).toHaveProperty('evicted_at');
      });

      it('cache_size_after reflects the size after the overflow eviction', () => {
         for (let i = 0; i < 252; i++) {
            const query = { ...BASE_QUERY, offset: i };
            setCachedCreatorList(query as any, [], 0);
         }

         const evictions = findEvictionCalls();
         const overflowEvictions = evictions.filter(
            e => e.reason === 'capacity_overflow'
         );

         for (const eviction of overflowEvictions) {
            expect(typeof eviction.cache_size_after === 'number').toBe(true);
            expect((eviction.cache_size_after as number) <= 250).toBe(true);
         }
      });

      it('evicted_at is a valid ISO 8601 timestamp on overflow eviction', () => {
         for (let i = 0; i < 252; i++) {
            const query = { ...BASE_QUERY, offset: i };
            setCachedCreatorList(query as any, [], 0);
         }

         const evictions = findEvictionCalls();
         const overflowEviction = evictions.find(
            e => e.reason === 'capacity_overflow'
         );
         const parsed = new Date(overflowEviction!.evicted_at as string);

         expect(parsed.toISOString()).toBe(overflowEviction!.evicted_at);
      });
   });
});
