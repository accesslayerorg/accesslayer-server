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
