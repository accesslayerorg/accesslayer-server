// src/modules/keys/key-cooldown.service.ts
// Buy cooldown status for a wallet on a key (#874, #968).

import { prisma } from '../../utils/prisma.utils';
import {
   cacheGetJson,
   cacheSetJson,
   cacheInvalidate,
   getRedis,
} from '../../utils/redis.utils';
import { logger } from '../../utils/logger.utils';
import { KeyNotFoundError } from './key-fees.service';

/** Approximate seconds per Stellar ledger. */
const SECONDS_PER_LEDGER = 5;
const BUY_COOLDOWN_REDIS_KEY_PREFIX = 'buy-cooldown';

export interface KeyCooldownStatus {
   key_id: string;
   wallet: string;
   active: boolean;
   is_active: boolean;
   cooldown_active: boolean;
   expires_at: string | null;
   unlock_estimated_at: string | null;
   seconds_remaining: number;
   remaining_seconds: number;
   cooldown_ledgers: number;
   cooldown_seconds: number;
   last_trade_at: string | null;
}

export const cooldownCacheKey = (keyId: string, wallet: string): string =>
   `keys:cooldown:${keyId}:${wallet.toLowerCase()}`;

/** Redis key holding the absolute buy-cooldown expiry for a wallet on a key. */
export function buildBuyCooldownRedisKey(
   keyId: string,
   walletAddress: string
): string {
   return `${BUY_COOLDOWN_REDIS_KEY_PREFIX}:${walletAddress.toLowerCase()}:${keyId.toLowerCase()}`;
}

/**
 * Resolves the buy cooldown duration for a key, in seconds. The duration is
 * configured per key through contract metadata, mirrored off-chain on
 * `CreatorProfile.cooldownLedgers` (in ledgers). Zero (or an unknown key)
 * disables the cooldown.
 */
export async function getCooldownDurationSeconds(
   keyId: string
): Promise<number> {
   const creator = await prisma.creatorProfile.findFirst({
      where: { OR: [{ id: keyId }, { handle: keyId }] },
      select: { id: true, cooldownLedgers: true },
   });
   if (!creator) {
      throw new KeyNotFoundError(keyId);
   }
   return Math.max(0, creator.cooldownLedgers * SECONDS_PER_LEDGER);
}

/**
 * Records a successful buy by storing the cooldown expiry in Redis keyed by
 * wallet address and key ID. The TTL matches the remaining cooldown so the key
 * self-expires exactly when the cooldown ends. Returns the ISO expiry, or
 * `null` when no cooldown is configured or the write failed.
 */
export async function setBuyCooldownForWallet(
   keyId: string,
   walletAddress: string
): Promise<string | null> {
   try {
      const durationSeconds = await getCooldownDurationSeconds(keyId);
      if (durationSeconds <= 0) {
         return null;
      }

      const expiresAt = new Date(
         Date.now() + durationSeconds * 1000
      ).toISOString();

      const redis = getRedis();
      if (!redis) {
         return expiresAt;
      }

      await redis.set(
         buildBuyCooldownRedisKey(keyId, walletAddress),
         expiresAt,
         'EX',
         durationSeconds
      );
      return expiresAt;
   } catch (error) {
      logger.warn(
         {
            type: 'buy_cooldown_set_failed',
            keyId,
            walletAddress,
            error: error instanceof Error ? error.message : String(error),
         },
         'Failed to persist buy cooldown in Redis'
      );
      return null;
   }
}

/**
 * Returns the active buy cooldown for a wallet on a key. Reads the Redis key
 * first; when Redis is unavailable, the key is missing, or the read fails, the
 * cooldown is recomputed from the database (indexed trade ledger vs. indexed
 * head) so enforcement still works during a Redis outage.
 */
export async function getBuyCooldownStatus(
   keyId: string,
   walletAddress: string
): Promise<{
   cooldownActive: boolean;
   cooldownExpiresAt: string | null;
   remainingSeconds: number;
}> {
   const redis = getRedis();
   const redisKey = buildBuyCooldownRedisKey(keyId, walletAddress);

   if (redis) {
      try {
         const cachedExpiry = await redis.get(redisKey);
         if (cachedExpiry) {
            const expiry = new Date(cachedExpiry);
            const remainingMs = expiry.getTime() - Date.now();
            if (!Number.isNaN(expiry.getTime()) && remainingMs > 0) {
               return {
                  cooldownActive: true,
                  cooldownExpiresAt: expiry.toISOString(),
                  remainingSeconds: Math.ceil(remainingMs / 1000),
               };
            }
            await redis.del(redisKey);
         }
      } catch (error) {
         logger.warn(
            {
               type: 'buy_cooldown_redis_read_failed',
               keyId,
               walletAddress,
               error: error instanceof Error ? error.message : String(error),
            },
            'Redis buy cooldown read failed; falling back to database'
         );
      }
   }

   const dbCooldown = await getKeyCooldown(keyId, walletAddress);
   if (!dbCooldown.cooldown_active || !dbCooldown.unlock_estimated_at) {
      return {
         cooldownActive: false,
         cooldownExpiresAt: null,
         remainingSeconds: 0,
      };
   }

   const cooldownExpiresAt = new Date(
      dbCooldown.unlock_estimated_at
   ).toISOString();

   const redisFallback = getRedis();
   if (redisFallback) {
      try {
         const remainingSeconds = Math.max(1, dbCooldown.remaining_seconds);
         await redisFallback.set(
            buildBuyCooldownRedisKey(keyId, walletAddress),
            cooldownExpiresAt,
            'EX',
            remainingSeconds
         );
      } catch (error) {
         logger.warn(
            {
               type: 'buy_cooldown_cache_write_failed',
               keyId,
               walletAddress,
               error: error instanceof Error ? error.message : String(error),
            },
            'Failed to warm Redis cooldown cache after database fallback'
         );
      }
   }

   return {
      cooldownActive: true,
      cooldownExpiresAt,
      remainingSeconds: dbCooldown.remaining_seconds,
   };
}

/**
 * Returns the buy cooldown status for a wallet on a key.
 * Cached in Redis with TTL equal to the remaining cooldown seconds (expires precisely when cooldown ends).
 */
export async function getKeyCooldown(
   keyId: string,
   walletAddress: string
): Promise<KeyCooldownStatus> {
   const normalizedWallet = walletAddress.toLowerCase();

   const creator = await prisma.creatorProfile.findFirst({
      where: { OR: [{ id: keyId }, { handle: keyId }] },
      select: { id: true, cooldownLedgers: true },
   });
   if (!creator) {
      throw new KeyNotFoundError(keyId);
   }

   const cacheKey = cooldownCacheKey(creator.id, normalizedWallet);
   const cached = await cacheGetJson<KeyCooldownStatus>(cacheKey);
   if (cached) {
      return cached;
   }

   const cooldownLedgers = creator.cooldownLedgers ?? 0;
   const cooldownSeconds = cooldownLedgers * SECONDS_PER_LEDGER;

   const buildInactive = (
      lastTradeAt: string | null = null
   ): KeyCooldownStatus => ({
      key_id: creator.id,
      wallet: walletAddress,
      active: false,
      is_active: false,
      cooldown_active: false,
      expires_at: null,
      unlock_estimated_at: null,
      seconds_remaining: 0,
      remaining_seconds: 0,
      cooldown_ledgers: cooldownLedgers,
      cooldown_seconds: cooldownSeconds,
      last_trade_at: lastTradeAt,
   });

   if (cooldownLedgers <= 0) {
      const res = buildInactive(null);
      await cacheSetJson(cacheKey, res, 10);
      return res;
   }

   const [lastBuy, indexed] = await Promise.all([
      prisma.trade.findFirst({
         where: { buyer: walletAddress, creatorId: creator.id },
         orderBy: { ledger: 'desc' },
         select: { ledger: true, timestamp: true },
      }),
      prisma.indexedLedger.findUnique({
         where: { id: 1 },
         select: { ledger: true },
      }),
   ]);

   const lastTradeAt = lastBuy?.timestamp
      ? lastBuy.timestamp instanceof Date
         ? lastBuy.timestamp.toISOString()
         : new Date(lastBuy.timestamp).toISOString()
      : null;

   if (!lastBuy || !indexed) {
      const res = buildInactive(lastTradeAt);
      await cacheSetJson(cacheKey, res, 10);
      return res;
   }

   const remainingLedgers = lastBuy.ledger + cooldownLedgers - indexed.ledger;
   if (remainingLedgers <= 0) {
      const res = buildInactive(lastTradeAt);
      await cacheSetJson(cacheKey, res, 10);
      return res;
   }

   const remainingSeconds = remainingLedgers * SECONDS_PER_LEDGER;
   const expiresAt = new Date(
      Date.now() + remainingSeconds * 1000
   ).toISOString();

   const activeStatus: KeyCooldownStatus = {
      key_id: creator.id,
      wallet: walletAddress,
      active: true,
      is_active: true,
      cooldown_active: true,
      expires_at: expiresAt,
      unlock_estimated_at: expiresAt,
      seconds_remaining: remainingSeconds,
      remaining_seconds: remainingSeconds,
      cooldown_ledgers: cooldownLedgers,
      cooldown_seconds: cooldownSeconds,
      last_trade_at: lastTradeAt,
   };

   // 10s TTL or remaining cooldown if less than 10s
   const ttl = Math.min(10, remainingSeconds > 0 ? remainingSeconds : 10);
   await cacheSetJson(cacheKey, activeStatus, ttl);
   return activeStatus;
}

/**
 * Returns cooldown status for multiple keys in batch (up to 50 key IDs).
 */
export async function getBatchCooldowns(
   keyIds: string[],
   walletAddress: string
): Promise<
   (
      | KeyCooldownStatus
      | {
           key_id: string;
           wallet: string;
           active: false;
           is_active: false;
           cooldown_active: false;
           expires_at: null;
           unlock_estimated_at: null;
           seconds_remaining: 0;
           remaining_seconds: 0;
           cooldown_ledgers: number;
           cooldown_seconds: number;
           last_trade_at: null;
           error: string;
        }
   )[]
> {
   if (keyIds.length > 50) {
      throw new Error('Batch request exceeds maximum of 50 key IDs');
   }

   return Promise.all(
      keyIds.map(async keyId => {
         try {
            return await getKeyCooldown(keyId, walletAddress);
         } catch (error) {
            if (error instanceof KeyNotFoundError) {
               return {
                  key_id: keyId,
                  wallet: walletAddress,
                  active: false,
                  is_active: false,
                  cooldown_active: false,
                  expires_at: null,
                  unlock_estimated_at: null,
                  seconds_remaining: 0,
                  remaining_seconds: 0,
                  cooldown_ledgers: 0,
                  cooldown_seconds: 0,
                  last_trade_at: null,
                  error: 'Key not found',
               };
            }
            throw error;
         }
      })
   );
}

/**
 * Invalidates the cooldown cache for a wallet on a key when a trade occurs.
 */
export async function invalidateCooldownCache(
   keyId: string,
   walletAddress: string
): Promise<void> {
   if (!walletAddress) return;
   const creator = await prisma.creatorProfile.findFirst({
      where: { OR: [{ id: keyId }, { handle: keyId }] },
      select: { id: true },
   });
   const resolvedId = creator?.id ?? keyId;
   await cacheInvalidate(
      cooldownCacheKey(resolvedId, walletAddress.toLowerCase())
   );
   if (resolvedId !== keyId) {
      await cacheInvalidate(
         cooldownCacheKey(keyId, walletAddress.toLowerCase())
      );
   }
}
