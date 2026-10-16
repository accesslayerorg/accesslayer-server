import {
   cacheGetJson,
   cacheSetJson,
   cacheInvalidate,
} from '../../utils/redis.utils';
import { logger } from '../../utils/logger.utils';

export const NONCE_CACHE_TTL_SECONDS = 30;
export const CONSUMED_NONCE_TTL_SECONDS = 3600;

export class NonceAlreadyConsumedError extends Error {
   constructor(
      public readonly wallet: string,
      public readonly nonce: number
   ) {
      super(`Nonce ${nonce} for wallet ${wallet} has already been consumed`);
      this.name = 'NonceAlreadyConsumedError';
   }
}

export class NonceMismatchError extends Error {
   constructor(
      public readonly wallet: string,
      public readonly expectedNonce: number,
      public readonly providedNonce: number
   ) {
      super(
         `Invalid nonce for wallet ${wallet}: expected ${expectedNonce}, received ${providedNonce}`
      );
      this.name = 'NonceMismatchError';
   }
}

export interface NonceContractProvider {
   getWalletNonce(wallet: string): Promise<number>;
}

export interface NonceInfo {
   wallet: string;
   nonce: number;
   cached: boolean;
}

const inMemoryOnChainNonces = new Map<string, number>();
const inMemoryConsumedNonces = new Set<string>();

const defaultContractProvider: NonceContractProvider = {
   async getWalletNonce(wallet: string): Promise<number> {
      return inMemoryOnChainNonces.get(wallet) ?? 0;
   },
};

function currentNonceCacheKey(wallet: string): string {
   return `nonce:current:${wallet}`;
}

function consumedNonceCacheKey(wallet: string, nonce: number): string {
   return `nonce:consumed:${wallet}:${nonce}`;
}

/**
 * Resets in-memory nonce state (used in unit/integration tests).
 */
export function resetNonceStateForTests(): void {
   inMemoryOnChainNonces.clear();
   inMemoryConsumedNonces.clear();
}

/**
 * Fetches the current single-use nonce for a wallet from the cache or on-chain
 * nonce registry contract, caching the result with a short TTL to reduce RPC load.
 */
export async function getWalletNonce(
   wallet: string,
   provider: NonceContractProvider = defaultContractProvider
): Promise<NonceInfo> {
   const cacheKey = currentNonceCacheKey(wallet);
   const cached = await cacheGetJson<{ nonce: number }>(cacheKey);
   if (cached !== null && typeof cached.nonce === 'number') {
      return {
         wallet,
         nonce: cached.nonce,
         cached: true,
      };
   }

   const onChainNonce = await provider.getWalletNonce(wallet);
   await cacheSetJson(
      cacheKey,
      { nonce: onChainNonce },
      NONCE_CACHE_TTL_SECONDS
   );

   return {
      wallet,
      nonce: onChainNonce,
      cached: false,
   };
}

/**
 * Checks whether a specific `(wallet, nonce)` pair has already been consumed.
 */
export async function isNonceConsumed(
   wallet: string,
   nonce: number
): Promise<boolean> {
   const key = consumedNonceCacheKey(wallet, nonce);
   if (inMemoryConsumedNonces.has(key)) {
      return true;
   }
   const cached = await cacheGetJson<{ consumedAt: string }>(key);
   return cached !== null;
}

/**
 * Consumes a single-use nonce for a wallet after a signed action executes:
 * - Rejects immediately with `NonceAlreadyConsumedError` (HTTP 409) if the nonce
 *   was already consumed
 * - Validates that the nonce matches the current expected nonce
 * - Marks the nonce as consumed in the replay cache
 * - Clears the stale current-nonce cache and advances the expected nonce
 */
export async function consumeWalletNonce(
   wallet: string,
   nonce: number,
   action?: string,
   provider: NonceContractProvider = defaultContractProvider
): Promise<{ wallet: string; consumedNonce: number; nextNonce: number }> {
   if (await isNonceConsumed(wallet, nonce)) {
      throw new NonceAlreadyConsumedError(wallet, nonce);
   }

   const current = await getWalletNonce(wallet, provider);
   if (nonce < current.nonce) {
      throw new NonceAlreadyConsumedError(wallet, nonce);
   }
   if (nonce !== current.nonce) {
      throw new NonceMismatchError(wallet, current.nonce, nonce);
   }

   const consumedKey = consumedNonceCacheKey(wallet, nonce);
   inMemoryConsumedNonces.add(consumedKey);
   await cacheSetJson(
      consumedKey,
      {
         wallet,
         nonce,
         action: action ?? 'signed_action',
         consumedAt: new Date().toISOString(),
      },
      CONSUMED_NONCE_TTL_SECONDS
   );

   const nextNonce = nonce + 1;
   inMemoryOnChainNonces.set(wallet, nextNonce);

   // Clear stale current-nonce cache immediately after increment
   await cacheInvalidate(currentNonceCacheKey(wallet));

   logger.info(
      { wallet, consumedNonce: nonce, nextNonce, action },
      'Consumed replay-protected nonce and invalidated stale cache'
   );

   return {
      wallet,
      consumedNonce: nonce,
      nextNonce,
   };
}

/**
 * Validates and consumes a nonce inside signed admin/governance action flows.
 */
export async function validateSignedActionNonce(
   wallet: string,
   nonce: number,
   action?: string,
   provider: NonceContractProvider = defaultContractProvider
): Promise<{ wallet: string; consumedNonce: number; nextNonce: number }> {
   return consumeWalletNonce(wallet, nonce, action, provider);
}
