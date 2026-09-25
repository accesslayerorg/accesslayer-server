// src/modules/keys/key-cooldown.service.ts
// Buy cooldown status for a wallet on a key (#874).

import { prisma } from '../../utils/prisma.utils';
import { KeyNotFoundError } from './key-fees.service';
import { getRedis } from '../../utils/redis.utils';
import { logger } from '../../utils/logger.utils';

/** Approximate seconds per Stellar ledger. */
const SECONDS_PER_LEDGER = 5;
const BUY_COOLDOWN_REDIS_KEY_PREFIX = 'buy-cooldown';

export interface KeyCooldown {
   cooldownActive: boolean;
   remainingSeconds: number;
   unlockEstimatedAt: string | null;
}

const NO_COOLDOWN: KeyCooldown = {
   cooldownActive: false,
   remainingSeconds: 0,
   unlockEstimatedAt: null,
};

/**
 * remainingSeconds = (last_buy_ledger + cooldown_ledgers - current_ledger) * 5.
 * last_buy_ledger is the wallet's most recent trade ledger on the key and
 * current_ledger is the latest indexed ledger. The cooldown is inactive when
 * none is configured, the wallet never bought, or the window has elapsed.
 */
export function buildBuyCooldownRedisKey(
   keyId: string,
   walletAddress: string
): string {
   return `${BUY_COOLDOWN_REDIS_KEY_PREFIX}:${walletAddress.toLowerCase()}:${keyId.toLowerCase()}`;
}

export async function getCooldownDurationSeconds(keyId: string): Promise<number> {
   const creator = await prisma.creatorProfile.findFirst({
      where: { OR: [{ id: keyId }, { handle: keyId }] },
      select: { id: true, cooldownLedgers: true },
   });
   if (!creator) {
      throw new KeyNotFoundError(keyId);
   }
   return Math.max(0, creator.cooldownLedgers * SECONDS_PER_LEDGER);
}

export async function setBuyCooldownForWallet(
   keyId: string,
   walletAddress: string
): Promise<string | null> {
   try {
      const durationSeconds = await getCooldownDurationSeconds(keyId);
      if (durationSeconds <= 0) {
         return null;
      }

      const redis = getRedis();
      const expiresAt = new Date(Date.now() + durationSeconds * 1000).toISOString();
      if (!redis) {
         return expiresAt;
      }

      const key = buildBuyCooldownRedisKey(keyId, walletAddress);
      await redis.set(key, expiresAt, 'EX', durationSeconds);
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

export async function getBuyCooldownStatus(
   keyId: string,
   walletAddress: string
): Promise<{ cooldownActive: boolean; cooldownExpiresAt: string | null; remainingSeconds: number }> {
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
   if (!dbCooldown.cooldownActive || !dbCooldown.unlockEstimatedAt) {
      return {
         cooldownActive: false,
         cooldownExpiresAt: null,
         remainingSeconds: 0,
      };
   }

   const cooldownExpiresAt = new Date(dbCooldown.unlockEstimatedAt).toISOString();
   if (redis) {
      try {
         const remainingSeconds = Math.max(1, dbCooldown.remainingSeconds);
         await redis.set(redisKey, cooldownExpiresAt, 'EX', remainingSeconds);
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
      remainingSeconds: dbCooldown.remainingSeconds,
   };
}

export async function getKeyCooldown(
   keyId: string,
   walletAddress: string
): Promise<KeyCooldown> {
   const creator = await prisma.creatorProfile.findFirst({
      where: { OR: [{ id: keyId }, { handle: keyId }] },
      select: { id: true, cooldownLedgers: true },
   });
   if (!creator) {
      throw new KeyNotFoundError(keyId);
   }
   if (creator.cooldownLedgers <= 0) {
      return NO_COOLDOWN;
   }

   const [lastBuy, indexed] = await Promise.all([
      prisma.trade.findFirst({
         where: { buyer: walletAddress, creatorId: creator.id },
         orderBy: { ledger: 'desc' },
         select: { ledger: true },
      }),
      prisma.indexedLedger.findUnique({
         where: { id: 1 },
         select: { ledger: true },
      }),
   ]);
   if (!lastBuy || !indexed) {
      return NO_COOLDOWN;
   }

   const remainingLedgers =
      lastBuy.ledger + creator.cooldownLedgers - indexed.ledger;
   if (remainingLedgers <= 0) {
      return NO_COOLDOWN;
   }

   const remainingSeconds = remainingLedgers * SECONDS_PER_LEDGER;
   return {
      cooldownActive: true,
      remainingSeconds,
      unlockEstimatedAt: new Date(
         Date.now() + remainingSeconds * 1000
      ).toISOString(),
   };
}
