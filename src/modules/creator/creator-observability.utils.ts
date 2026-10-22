import { logger } from '../../utils/logger.utils';

const creatorRouteBootMs = Date.now();
const loggedHandlers = new Set<string>();

/**
 * Emits a one-time debug log for the first invocation of a creator route handler.
 *
 * The log is intentionally debug-level so it stays out of production info logs
 * while still giving operators a signal when a route's first request is slower
 * than expected.
 */
export function logCreatorRouteColdStart(
   handler: string,
   requestId?: string
): void {
   if (loggedHandlers.has(handler)) {
      return;
   }

   loggedHandlers.add(handler);

   logger.debug(
      {
         type: 'creator_route_cold_start',
         handler,
         elapsedMs: Date.now() - creatorRouteBootMs,
         ...(requestId ? { requestId } : {}),
      },
      'Creator route cold start detected'
   );
}

/**
 * Emits a debug-level log for a creator profile cache hit.
 *
 * Includes the remaining TTL so operators can measure cache effectiveness
 * and tune the TTL. Must be called before the cached result is used.
 */
export function logCreatorProfileCacheHit(
   creatorWallet: string,
   cacheKey: string,
   ttlRemainingMs: number
): void {
   logger.debug(
      {
         type: 'creator_profile_cache_hit',
         creator_wallet: creatorWallet,
         cache_key: cacheKey,
         hit: true,
         ttl_remaining_ms: ttlRemainingMs,
      },
      'Creator profile cache hit'
   );
}

/**
 * Emits a debug-level log for a creator profile cache miss.
 *
 * Must be called before the cache lookup result is used so the miss is
 * recorded even if the subsequent Horizon call fails.
 */
export function logCreatorProfileCacheMiss(
   creatorWallet: string,
   cacheKey: string
): void {
   logger.debug(
      {
         type: 'creator_profile_cache_miss',
         creator_wallet: creatorWallet,
         cache_key: cacheKey,
         hit: false,
      },
      'Creator profile cache miss'
   );
}
