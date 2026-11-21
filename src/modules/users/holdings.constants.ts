// src/modules/users/holdings.constants.ts
// Tunables for the wallet holdings endpoint.

const HOLDINGS_CACHE_PREFIX = 'users:holdings';

/** Deterministic Redis cache key for a wallet's holdings payload. */
export function buildHoldingsCacheKey(wallet: string): string {
   return `${HOLDINGS_CACHE_PREFIX}:${wallet.toLowerCase()}`;
}
