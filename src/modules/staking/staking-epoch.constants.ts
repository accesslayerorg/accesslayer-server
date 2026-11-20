// src/modules/staking/staking-epoch.constants.ts
// Cache key builders and TTLs for the staking epoch endpoints (#1086).

/** Redis TTL for the active-positions list (30 seconds — kept short because
 *  accrued rewards are fetched live per request, not cached here). */
export const STAKING_POSITIONS_CACHE_TTL_SECONDS = 30;

/** Redis TTL for the key epoch history list (60 seconds). */
export const STAKING_KEY_EPOCHS_CACHE_TTL_SECONDS = 60;

const PREFIX = 'staking:epoch';

export function buildPositionsCacheKey(wallet: string): string {
   return `${PREFIX}:positions:${wallet.toLowerCase()}`;
}

export function buildPositionDetailCacheKey(
   wallet: string,
   stakeId: string
): string {
   return `${PREFIX}:position:${wallet.toLowerCase()}:${stakeId}`;
}

export function buildKeyEpochsCacheKey(
   keyId: string,
   offset: number,
   limit: number
): string {
   return `${PREFIX}:key-epochs:${keyId}:${offset}:${limit}`;
}

/** Glob pattern for all cached artifacts for a wallet. */
export function stakingEpochWalletCachePattern(wallet: string): string {
   return `${PREFIX}:position*:${wallet.toLowerCase()}*`;
}
