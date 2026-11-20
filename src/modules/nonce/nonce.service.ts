// src/modules/nonce/nonce.service.ts
// Service layer for nonce management and replay-protected signed actions (#1039).

import {
   cacheGetJson,
   cacheSetJson,
   cacheInvalidate,
} from '../../utils/redis.utils';
import { logger } from '../../utils/logger.utils';
import { envConfig } from '../../config';
import {
   NonceAlreadyConsumedError,
   NonceMismatchError,
   NonceContractUnavailableError,
} from './nonce.errors';
import type {
   NonceInfo,
   ConsumeNonceResult,
   ConsumedNonceRecord,
   NonceContractProvider,
} from './nonce.types';
import {
   defaultNonceContractProvider,
   resetTrackedOnChainNonces,
   setTrackedOnChainNonce,
} from './nonce.contract';

export {
   NonceAlreadyConsumedError,
   NonceMismatchError,
   NonceContractUnavailableError,
   type NonceInfo,
   type ConsumeNonceResult,
   type NonceContractProvider,
};

export const DEFAULT_NONCE_CACHE_TTL_SECONDS = 30;
export const CONSUMED_NONCE_TTL_SECONDS = 86400; // 24 hours

const inMemoryConsumedNonces = new Set<string>();

export function currentNonceCacheKey(wallet: string): string {
   return `nonce:current:${wallet}`;
}

export function consumedNonceCacheKey(wallet: string, nonce: number): string {
   return `nonce:consumed:${wallet}:${nonce}`;
}

/**
 * Resets in-memory nonce cache and contract tracking for isolated testing.
 */
export function resetNonceStateForTests(): void {
   inMemoryConsumedNonces.clear();
   resetTrackedOnChainNonces();
}

/**
 * Fetches the current nonce for a wallet.
 * Checks Redis cache first. On cache miss, reads from the contract provider and
 * caches the result with a short TTL to reduce contract calls under load.
 */
export async function getWalletNonce(
   wallet: string,
   provider: NonceContractProvider = defaultNonceContractProvider
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
   const ttlSeconds =
      (envConfig as any).NONCE_CACHE_TTL_SECONDS ??
      DEFAULT_NONCE_CACHE_TTL_SECONDS;

   await cacheSetJson(cacheKey, { nonce: onChainNonce }, ttlSeconds);

   return {
      wallet,
      nonce: onChainNonce,
      cached: false,
   };
}

/**
 * Checks whether a `(wallet, nonce)` pair has already been consumed.
 */
export async function isNonceConsumed(
   wallet: string,
   nonce: number
): Promise<boolean> {
   const key = consumedNonceCacheKey(wallet, nonce);
   if (inMemoryConsumedNonces.has(key)) {
      return true;
   }
   const cached = await cacheGetJson<ConsumedNonceRecord>(key);
   return cached !== null;
}

/**
 * Consumes a single-use nonce for a wallet:
 * - Rejects immediately with NonceAlreadyConsumedError (409) if already consumed
 * - Verifies that the nonce matches the expected current nonce
 * - Marks the nonce as consumed in replay storage (TTL 24 hours)
 * - Advances the expected nonce
 * - Immediately invalidates stale current nonce cache
 */
export async function consumeWalletNonce(
   wallet: string,
   nonce: number,
   action?: string,
   provider: NonceContractProvider = defaultNonceContractProvider
): Promise<ConsumeNonceResult> {
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
   setTrackedOnChainNonce(wallet, nextNonce);

   // Clear stale current nonce cache immediately
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
 * Helper to validate and consume nonces inside signed admin/governance action flows.
 */
export async function validateSignedActionNonce(
   wallet: string,
   nonce: number,
   action?: string,
   provider: NonceContractProvider = defaultNonceContractProvider
): Promise<ConsumeNonceResult> {
   return consumeWalletNonce(wallet, nonce, action, provider);
}
