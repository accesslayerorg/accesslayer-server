// src/modules/keys/key-holding-capacity.service.ts
// Wallet holding cap and remaining purchase capacity for a key (#913).

import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';
import { KeyNotFoundError } from './key-fees.service';

export const HOLDING_CAPACITY_CACHE_TTL_SECONDS = 10;

const BPS_DENOMINATOR = 10_000;

export interface KeyHoldingCapacity {
   keyId: string;
   wallet: string;
   current_holding: number;
   cap: number;
   remaining_capacity: number;
   cap_percentage: number;
   /** Whether the requested quantity fits within the remaining capacity. */
   allowed: boolean;
}

/**
 * Max keys a single wallet may hold: holder_cap_bps of total supply, floored
 * to whole keys. Total supply is the configured supply cap, or circulating
 * supply when the key is uncapped.
 */
export function computeHoldingCap(
   holderCapBps: number,
   supplyCap: number | null,
   circulatingSupply: number
): number {
   const totalSupply = supplyCap ?? circulatingSupply;
   return Math.floor((totalSupply * holderCapBps) / BPS_DENOMINATOR);
}

/**
 * Share of the cap already held, as a percentage rounded to 2 decimals and
 * clamped to [0, 100] for progress display.
 */
export function computeCapPercentage(holding: number, cap: number): number {
   if (cap <= 0) {
      return holding > 0 ? 100 : 0;
   }
   const pct = Math.min((holding / cap) * 100, 100);
   return Math.round(pct * 100) / 100;
}

/**
 * Returns the wallet's current holding, configured cap, remaining purchase
 * capacity, and whether the requested quantity fits within the cap.
 * Holding is read from the indexed on-chain position (KeyOwnership).
 * Cached for 10s per key + wallet.
 *
 * @param keyId         - Creator profile ID or handle.
 * @param walletAddress - Stellar wallet address.
 * @param quantity      - Optional buy quantity to validate. Defaults to 0
 *                        (allowed will be true as long as any capacity remains).
 */
export async function getKeyHoldingCapacity(
   keyId: string,
   walletAddress: string,
   quantity = 0
): Promise<KeyHoldingCapacity> {
   const cacheKey = `keys:holding-capacity:${keyId}:${walletAddress}`;
   const cached =
      await cacheGetJson<Omit<KeyHoldingCapacity, 'allowed'>>(cacheKey);

   let current_holding: number;
   let cap: number;
   let remaining_capacity: number;
   let cap_percentage: number;
   let resolvedKeyId: string;

   if (cached) {
      current_holding = cached.current_holding;
      cap = cached.cap;
      remaining_capacity = cached.remaining_capacity;
      cap_percentage = cached.cap_percentage;
      resolvedKeyId = cached.keyId;
   } else {
      const creator = await prisma.creatorProfile.findFirst({
         where: { OR: [{ id: keyId }, { handle: keyId }] },
         select: {
            id: true,
            holderCapBps: true,
            supplyCap: true,
            circulatingSupply: true,
         },
      });
      if (!creator) {
         throw new KeyNotFoundError(keyId);
      }

      const ownership = await prisma.keyOwnership.findUnique({
         where: {
            ownerAddress_creatorId: {
               ownerAddress: walletAddress,
               creatorId: creator.id,
            },
         },
         select: { balance: true },
      });

      current_holding = Number(ownership?.balance ?? 0);
      cap = computeHoldingCap(
         creator.holderCapBps,
         creator.supplyCap,
         Number(creator.circulatingSupply)
      );
      remaining_capacity = Math.max(cap - current_holding, 0);
      cap_percentage = computeCapPercentage(current_holding, cap);
      resolvedKeyId = creator.id;

      const toCache: Omit<KeyHoldingCapacity, 'allowed'> = {
         keyId: resolvedKeyId,
         wallet: walletAddress,
         current_holding,
         cap,
         remaining_capacity,
         cap_percentage,
      };
      await cacheSetJson(cacheKey, toCache, HOLDING_CAPACITY_CACHE_TTL_SECONDS);
   }

   // `allowed` is computed per-request from the (possibly cached) capacity
   // values and the caller-supplied quantity so different quantity checks
   // against the same wallet share the same cached base data.
   const allowed = current_holding + quantity <= cap;

   return {
      keyId: resolvedKeyId,
      wallet: walletAddress,
      current_holding,
      cap,
      remaining_capacity,
      cap_percentage,
      allowed,
   };
}
