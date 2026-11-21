import {
   buildDiscoveryCacheKey,
   DISCOVERY_CACHE_TTL_MS,
   getDiscoveryCacheRemainingTtlMs,
   getGraduating,
   getNewKeys,
   getTrending,
} from '../modules/keys/discovery.service';
import {
   buildKeyLeaderboardCacheKey,
   getKeyLeaderboardCacheRemainingTtlMs,
   getKeyLeaderboard,
   KEY_LEADERBOARD_CACHE_TTL_SECONDS,
} from '../modules/keys/key-leaderboard.service';

export const CACHE_WARM_INTERVAL_MS = 5 * 60 * 1000;
export const CACHE_WARM_CONCURRENCY = 2;
export const CACHE_WARM_MAX_JITTER_MS = 10 * 1000;
export const CACHE_WARM_SKIP_THRESHOLD = 0.5;

const DISCOVERY_LIMIT = 20;
const LEADERBOARD_LIMIT = 20;
const LEADERBOARD_SORT = 'holder_count' as const;

export interface CacheWarmTarget {
   name: string;
   cacheKey: () => string;
   ttlMs: number;
   getRemainingTtlMs: () => number | null | Promise<number | null>;
   warm: () => Promise<unknown>;
}

export const WARM_TARGETS: readonly CacheWarmTarget[] = [
   {
      name: 'discovery-new',
      cacheKey: () => buildDiscoveryCacheKey('new', DISCOVERY_LIMIT),
      ttlMs: DISCOVERY_CACHE_TTL_MS,
      getRemainingTtlMs: () =>
         getDiscoveryCacheRemainingTtlMs(
            buildDiscoveryCacheKey('new', DISCOVERY_LIMIT)
         ),
      warm: () => getNewKeys(DISCOVERY_LIMIT),
   },
   {
      name: 'discovery-graduating',
      cacheKey: () => buildDiscoveryCacheKey('graduating', DISCOVERY_LIMIT),
      ttlMs: DISCOVERY_CACHE_TTL_MS,
      getRemainingTtlMs: () =>
         getDiscoveryCacheRemainingTtlMs(
            buildDiscoveryCacheKey('graduating', DISCOVERY_LIMIT)
         ),
      warm: () => getGraduating(DISCOVERY_LIMIT),
   },
   {
      name: 'trending',
      cacheKey: () => buildDiscoveryCacheKey('trending', DISCOVERY_LIMIT),
      ttlMs: DISCOVERY_CACHE_TTL_MS,
      getRemainingTtlMs: () =>
         getDiscoveryCacheRemainingTtlMs(
            buildDiscoveryCacheKey('trending', DISCOVERY_LIMIT)
         ),
      warm: () => getTrending(DISCOVERY_LIMIT),
   },
   {
      name: 'leaderboard',
      cacheKey: () => buildKeyLeaderboardCacheKey(LEADERBOARD_SORT),
      ttlMs: KEY_LEADERBOARD_CACHE_TTL_SECONDS * 1000,
      getRemainingTtlMs: () =>
         getKeyLeaderboardCacheRemainingTtlMs(LEADERBOARD_SORT),
      warm: () => getKeyLeaderboard(LEADERBOARD_SORT, LEADERBOARD_LIMIT),
   },
];
