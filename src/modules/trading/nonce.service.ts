// src/modules/trading/nonce.service.ts
// Service for generating, storing, and atomically consuming single-use trade nonces (#1194).

import { randomBytes } from 'crypto';
import { getRedis } from '../../utils/redis.utils';
import { envConfig } from '../../config';
import { logger } from '../../utils/logger.utils';

export function getNonceRedisKey(wallet: string, nonce: string): string {
   return `nonce:${wallet}:${nonce}`;
}

export function getWalletNonceRedisKey(wallet: string): string {
   return `nonce:${wallet}`;
}

const LUA_CONSUME_NONCE_SCRIPT = `
local walletKey = KEYS[1]
local exactKey = KEYS[2]
local expectedNonce = ARGV[1]

local exactDel = redis.call('DEL', exactKey)
local walletVal = redis.call('GET', walletKey)

if exactDel == 1 then
    if walletVal == expectedNonce then
        redis.call('DEL', walletKey)
    end
    return 1
elseif walletVal == expectedNonce then
    redis.call('DEL', walletKey)
    return 1
else
    return 0
end
`;

/**
 * Generates a fresh one-time nonce for a given wallet, stores it in Redis with
 * the configured TTL, and returns the nonce and expiry duration.
 */
export async function issueNonce(
   wallet: string,
   customTtlSeconds?: number
): Promise<{ nonce: string; expiresIn: number }> {
   const ttl =
      typeof customTtlSeconds === 'number' && customTtlSeconds > 0
         ? customTtlSeconds
         : envConfig.NONCE_TTL_SECONDS || 300;

   const nonce = randomBytes(16).toString('hex');
   const redis = getRedis();

   if (redis) {
      try {
         await Promise.all([
            redis.set(getNonceRedisKey(wallet, nonce), '1', 'EX', ttl),
            redis.set(getWalletNonceRedisKey(wallet), nonce, 'EX', ttl),
         ]);
      } catch (error) {
         logger.warn(
            {
               type: 'nonce_set_failed',
               wallet,
               error: error instanceof Error ? error.message : String(error),
            },
            'Failed to store trade nonce in Redis'
         );
      }
   } else {
      logger.warn(
         { wallet },
         'Redis is unavailable; nonce generated without persistent cache'
      );
   }

   return { nonce, expiresIn: ttl };
}

/**
 * Atomically verifies and consumes a trade nonce for a wallet.
 * Returns true if the nonce was valid and successfully deleted.
 * Returns false if the nonce was expired, already used, missing, or mismatched.
 */
export async function consumeNonce(
   wallet: string,
   nonce: string
): Promise<boolean> {
   if (!wallet || !nonce || typeof nonce !== 'string' || !nonce.trim()) {
      return false;
   }

   const redis = getRedis();
   if (!redis) {
      logger.warn(
         { wallet },
         'Redis is unavailable during nonce consumption — rejecting for replay protection'
      );
      return false;
   }

   const walletKey = getWalletNonceRedisKey(wallet);
   const exactKey = getNonceRedisKey(wallet, nonce);

   try {
      if (typeof redis.eval === 'function') {
         const result = await redis.eval(
            LUA_CONSUME_NONCE_SCRIPT,
            2,
            walletKey,
            exactKey,
            nonce
         );
         return result === 1 || result === '1';
      }

      // Fallback for mocks without eval support
      const exactDel = await redis.del(exactKey);
      if (exactDel === 1) {
         const walletVal = await redis.get(walletKey);
         if (walletVal === nonce) {
            await redis.del(walletKey);
         }
         return true;
      }

      const walletVal = await redis.get(walletKey);
      if (walletVal === nonce) {
         await redis.del(walletKey);
         return true;
      }

      return false;
   } catch (error) {
      logger.error(
         {
            type: 'nonce_consume_failed',
            wallet,
            error: error instanceof Error ? error.message : String(error),
         },
         'Exception during atomic nonce consumption in Redis'
      );
      return false;
   }
}
