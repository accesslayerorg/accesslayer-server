// src/modules/keys/key-holding-capacity.service.ts
// Wallet holding cap and remaining purchase capacity for a key (#945).

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
   remaining: number;
   cap_percentage: number;
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
 * Returns the wallet's current holding, configured cap, and remaining
 * purchase capacity on a key. Holding is read from the indexed on-chain
 * position (KeyOwnership). Cached for 10s per key + wallet.
 */
export async function getKeyHoldingCapacity(
   keyId: string,
   walletAddress: string
): Promise<KeyHoldingCapacity> {
   const cacheKey = `keys:holding-capacity:${keyId}:${walletAddress}`;
   const cached = await cacheGetJson<KeyHoldingCapacity>(cacheKey);
   if (cached) {
      return cached;
   }

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

   const currentHolding = Number(ownership?.balance ?? 0);
   const cap = computeHoldingCap(
      creator.holderCapBps,
      creator.supplyCap,
      Number(creator.circulatingSupply)
   );

   const capacity: KeyHoldingCapacity = {
      keyId: creator.id,
      wallet: walletAddress,
      current_holding: currentHolding,
      cap,
      remaining: Math.max(cap - currentHolding, 0),
      cap_percentage: computeCapPercentage(currentHolding, cap),
   };

   await cacheSetJson(cacheKey, capacity, HOLDING_CAPACITY_CACHE_TTL_SECONDS);
   return capacity;
}
