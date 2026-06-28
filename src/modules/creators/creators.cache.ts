import { CREATOR_PUBLIC_ROUTE_CACHE_MAX_AGE_SECONDS } from '../../constants/creator-public-cache.constants';
import { logger } from '../../utils/logger.utils';
import { CreatorProfile } from '../../types/profile.types';
import { CreatorListQueryType } from './creators.schemas';
import { buildCreatorFeedCacheKey } from './creators-cache-key.utils';

type CreatorListCacheEntry = {
   creators: CreatorProfile[];
   total: number;
   expiresAt: number;
};

type CreatorListCacheStats = {
   hits: number;
   misses: number;
};

const creatorListCache = new Map<string, CreatorListCacheEntry>();
const creatorListCacheStats: CreatorListCacheStats = {
   hits: 0,
   misses: 0,
};
const MAX_CREATOR_LIST_CACHE_ENTRIES = 250;

function getCreatorListCacheTtlMs(): number {
   return CREATOR_PUBLIC_ROUTE_CACHE_MAX_AGE_SECONDS.publicRead * 1000;
}

function pruneCreatorListCache(now: number): void {
   for (const [cacheKey, entry] of creatorListCache.entries()) {
      if (entry.expiresAt <= now) {
         logger.debug({
            msg: 'Creator list cache eviction',
            event: 'creator_list_cache_eviction',
            cacheKey,
            reason: 'expired',
            expiresAt: entry.expiresAt,
            now,
         });
         creatorListCache.delete(cacheKey);
      }
   }

   if (creatorListCache.size <= MAX_CREATOR_LIST_CACHE_ENTRIES) {
      return;
   }

   const overflow = creatorListCache.size - MAX_CREATOR_LIST_CACHE_ENTRIES;
   const oldestEntries = [...creatorListCache.entries()]
      .sort((left, right) => left[1].expiresAt - right[1].expiresAt)
      .slice(0, overflow);

   for (const [cacheKey] of oldestEntries) {
      logger.debug({
         msg: 'Creator list cache eviction',
         event: 'creator_list_cache_eviction',
         cacheKey,
         reason: 'overflow',
         cacheSize: creatorListCache.size,
         maxSize: MAX_CREATOR_LIST_CACHE_ENTRIES,
      });
      creatorListCache.delete(cacheKey);
   }
}

function logCreatorListCacheLookup(input: {
   cacheKey: string;
   hit: boolean;
   query: CreatorListQueryType;
}): void {
   if (!logger.isLevelEnabled('debug')) {
      return;
   }

   const totalLookups =
      creatorListCacheStats.hits + creatorListCacheStats.misses;
   const hitRatio =
      totalLookups === 0 ? 0 : creatorListCacheStats.hits / totalLookups;

   logger.debug({
      msg: 'Creator list cache lookup',
      event: 'creator_list_cache_lookup',
      cacheKey: input.cacheKey,
      cacheHit: input.hit,
      cacheHits: creatorListCacheStats.hits,
      cacheMisses: creatorListCacheStats.misses,
      cacheHitRatio: hitRatio,
      ttlMs: getCreatorListCacheTtlMs(),
      limit: input.query.limit,
      offset: input.query.offset,
      sort: input.query.sort,
      order: input.query.order,
      hasSearch: input.query.search !== undefined,
      hasVerifiedFilter: input.query.verified !== undefined,
   });
}

export function getCachedCreatorList(
   query: CreatorListQueryType
): { creators: CreatorProfile[]; total: number } | null {
   const cacheKey = buildCreatorFeedCacheKey(query);
   const cachedEntry = creatorListCache.get(cacheKey);
   const now = Date.now();

   if (cachedEntry && cachedEntry.expiresAt > now) {
      creatorListCacheStats.hits += 1;
      logCreatorListCacheLookup({
         cacheKey,
         hit: true,
         query,
      });

      return {
         creators: [...cachedEntry.creators],
         total: cachedEntry.total,
      };
   }

   if (cachedEntry) {
      logger.debug({
         msg: 'Creator list cache eviction',
         event: 'creator_list_cache_eviction',
         cacheKey,
         reason: 'stale',
         expiresAt: cachedEntry.expiresAt,
         now,
      });
      creatorListCache.delete(cacheKey);
   }

   pruneCreatorListCache(now);

   creatorListCacheStats.misses += 1;
   logCreatorListCacheLookup({
      cacheKey,
      hit: false,
      query,
   });

   return null;
}

export function setCachedCreatorList(
   query: CreatorListQueryType,
   creators: CreatorProfile[],
   total: number
): void {
   const cacheKey = buildCreatorFeedCacheKey(query);
   const now = Date.now();

   creatorListCache.set(cacheKey, {
      creators: [...creators],
      total,
      expiresAt: now + getCreatorListCacheTtlMs(),
   });

   pruneCreatorListCache(now);
}

export function resetCreatorListCache(): void {
   creatorListCache.clear();
   creatorListCacheStats.hits = 0;
   creatorListCacheStats.misses = 0;
}
