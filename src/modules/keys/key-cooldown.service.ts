// src/modules/keys/key-cooldown.service.ts
// Buy cooldown status for a wallet on a key (#874, #968).

import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson, cacheInvalidate } from '../../utils/redis.utils';
import { KeyNotFoundError } from './key-fees.service';

/** Approximate seconds per Stellar ledger. */
const SECONDS_PER_LEDGER = 5;

export interface KeyCooldownStatus {
   key_id: string;
   wallet: string;
   active: boolean;
   cooldown_active: boolean;
   expires_at: string | null;
   unlock_estimated_at: string | null;
   seconds_remaining: number;
   remaining_seconds: number;
   cooldown_ledgers: number;
   cooldown_seconds: number;
}

export const cooldownCacheKey = (keyId: string, wallet: string): string =>
   `keys:cooldown:${keyId}:${wallet.toLowerCase()}`;

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

   const buildInactive = (): KeyCooldownStatus => ({
      key_id: creator.id,
      wallet: walletAddress,
      active: false,
      cooldown_active: false,
      expires_at: null,
      unlock_estimated_at: null,
      seconds_remaining: 0,
      remaining_seconds: 0,
      cooldown_ledgers: cooldownLedgers,
      cooldown_seconds: cooldownSeconds,
   });

   if (cooldownLedgers <= 0) {
      const res = buildInactive();
      await cacheSetJson(cacheKey, res, 10);
      return res;
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
      const res = buildInactive();
      await cacheSetJson(cacheKey, res, 10);
      return res;
   }

   const remainingLedgers =
      lastBuy.ledger + cooldownLedgers - indexed.ledger;
   if (remainingLedgers <= 0) {
      const res = buildInactive();
      await cacheSetJson(cacheKey, res, 10);
      return res;
   }

   const remainingSeconds = remainingLedgers * SECONDS_PER_LEDGER;
   const expiresAt = new Date(Date.now() + remainingSeconds * 1000).toISOString();

   const activeStatus: KeyCooldownStatus = {
      key_id: creator.id,
      wallet: walletAddress,
      active: true,
      cooldown_active: true,
      expires_at: expiresAt,
      unlock_estimated_at: expiresAt,
      seconds_remaining: remainingSeconds,
      remaining_seconds: remainingSeconds,
      cooldown_ledgers: cooldownLedgers,
      cooldown_seconds: cooldownSeconds,
   };

   // Cache expires precisely when cooldown ends (TTL = remainingSeconds)
   await cacheSetJson(cacheKey, activeStatus, remainingSeconds > 0 ? remainingSeconds : 10);
   return activeStatus;
}

/**
 * Returns cooldown status for multiple keys in batch (up to 50 key IDs).
 */
export async function getBatchCooldowns(
   keyIds: string[],
   walletAddress: string
): Promise<(KeyCooldownStatus | { key_id: string; wallet: string; active: false; cooldown_active: false; expires_at: null; unlock_estimated_at: null; seconds_remaining: 0; remaining_seconds: 0; cooldown_ledgers: number; cooldown_seconds: number; error: string })[]> {
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
                  cooldown_active: false,
                  expires_at: null,
                  unlock_estimated_at: null,
                  seconds_remaining: 0,
                  remaining_seconds: 0,
                  cooldown_ledgers: 0,
                  cooldown_seconds: 0,
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
   await cacheInvalidate(cooldownCacheKey(resolvedId, walletAddress.toLowerCase()));
}
