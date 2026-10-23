// src/constants/redis.constants.ts
// Redis key helpers and TTLs for TWAP price caching (#963).
// Kept out of notifications.constants.ts so price-cache concerns live
// in one place alongside future Redis-backed caches.

export const TWAP_WINDOWS = ['1h', '4h', '24h'] as const;
export type TwapWindow = (typeof TWAP_WINDOWS)[number];

export const TWAP_WINDOW_MS: Record<TwapWindow, number> = {
   '1h': 60 * 60 * 1000,
   '4h': 4 * 60 * 60 * 1000,
   '24h': 24 * 60 * 60 * 1000,
};

// TTL matches the window size so longer windows stay cached longer.
export const TWAP_CACHE_TTL_SECONDS: Record<TwapWindow, number> = {
   '1h': 60 * 60,
   '4h': 4 * 60 * 60,
   '24h': 24 * 60 * 60,
};

export const twapRedisKey = (keyId: string, window: TwapWindow): string =>
   `twap:${keyId}:${window}`;

// Stale when the computation job is behind by 2x its 5-minute interval.
export const TWAP_STALE_THRESHOLD_MS = 10 * 60 * 1000;

// Cap on snapshots scanned per TWAP computation (matches price-history cap).
export const TWAP_MAX_SNAPSHOTS = 5000;

// Circuit breaker config cache (#987): the contract-read max_bps per key.
// Entries expire after CIRCUIT_BREAKER_CONFIG_CACHE_TTL_SECONDS (5 minutes),
// so the stored configuration is refreshed from the contract every 5 minutes.
export const circuitBreakerConfigRedisKey = (keyId: string): string =>
   `circuit-breaker:config:${keyId}`;

// ── TWAP snapshot endpoint (#1082) ───────────────────────────────
// GET /keys/:key_id/twap is served from the indexed twap_snapshots table
// with a short 60s TTL. A distinct namespace keeps it separate from the
// #963 job cache (`twap:{keyId}:{window}`) so invalidation never collides.
export const TWAP_SNAPSHOT_CACHE_TTL_SECONDS = 60;

export const twapSnapshotCacheKey = (
   keyId: string,
   window: TwapWindow
): string => `twap:snapshot:${keyId}:${window}`;

// ── Order book depth endpoints (#1152) ───────────────────────────
// GET /keys/:key_id/depth and /depth/spread are served from the indexed
// key_depth table with a 5s TTL and invalidated per key by the indexer on
// every DepthUpdated event. The depth response varies by `levels`, so keys
// are `depth:{keyId}:levels:{n}`; the indexer drops them all with the
// `depth:{keyId}:*` pattern.
export const KEY_DEPTH_CACHE_TTL_SECONDS = 5;

export const keyDepthCacheKey = (keyId: string, levels: number): string =>
   `depth:${keyId}:levels:${levels}`;

export const keyDepthSpreadCacheKey = (keyId: string): string =>
   `depth:${keyId}:spread`;

export const keyDepthCachePattern = (keyId: string): string =>
   `depth:${keyId}:*`;

// ── Co-creator roster endpoints (#1139) ─────────────────────────
// GET /keys/:key_id/co-creators and /co-creators/:wallet are served from
// the indexed key_cocreators table with a 60s TTL. Both the list and any
// per-wallet detail share the `key:cocreators:{keyId}:` prefix so the
// indexer can drop everything for a key with one pattern.
export const KEY_COCREATOR_CACHE_TTL_SECONDS = 60;

export const keyCoCreatorListCacheKey = (keyId: string): string =>
   `key:cocreators:${keyId}:list`;

export const keyCoCreatorDetailCacheKey = (
   keyId: string,
   wallet: string
): string => `key:cocreators:${keyId}:${wallet}`;

export const keyCoCreatorCachePattern = (keyId: string): string =>
   `key:cocreators:${keyId}:*`;

// ── Reserve balance endpoint (#1140) ────────────────────────────
// GET /keys/:key_id/reserve is served from the indexed key_reserves table
// with a 60s TTL, invalidated per key on every ReserveAccrued /
// ReserveDeployed event.
export const KEY_RESERVE_CACHE_TTL_SECONDS = 60;

export const keyReserveCacheKey = (keyId: string): string =>
   `key:reserve:${keyId}`;

// ── Content access endpoint (#1137) ─────────────────────────────
// GET /keys/:key_id/content-access/:wallet is evaluated on chain (or
// off-chain from indexed state) with a 30s TTL. Invalidated per key on
// KEY_BOUGHT/KEY_SOLD (balance changes) so a just-completed trade is
// visible immediately.
export const CONTENT_ACCESS_CACHE_TTL_SECONDS = 30;

export const contentAccessCacheKey = (
   keyId: string,
   wallet: string
): string => `key:content-access:${keyId}:${wallet}`;

export const contentAccessCachePattern = (keyId: string): string =>
   `key:content-access:${keyId}:*`;

// ── Tip history endpoints (#1132) ───────────────────────────────
// GET /keys/:key_id/tips and /tips/total are served from the indexed
// key_tips / key_tip_totals tables with a 60s TTL. IPFS tip message
// content fetched on demand is cached longer (immutable per CID).
export const KEY_TIPS_CACHE_TTL_SECONDS = 60;
export const KEY_TIP_CONTENT_CACHE_TTL_SECONDS = 3600;

export const keyTipsListCacheKey = (
   keyId: string,
   limit: number,
   cursor: string
): string => `key:tips:${keyId}:list:${limit}:${cursor}`;

export const keyTipsTotalCacheKey = (keyId: string): string =>
   `key:tips:${keyId}:total`;

export const keyTipContentCacheKey = (messageHash: string): string =>
   `key:tips:content:${messageHash}`;

export const keyTipsCachePattern = (keyId: string): string =>
   `key:tips:${keyId}:*`;
