// src/modules/keys/key-swap-fee.service.ts
// Service for fetching dynamic swap fee tier, volume bracket, rolling 24h volume,
// and FeeAdjusted change history with 60s TTL caching.

import { prisma } from '../../utils/prisma.utils';
import {
   cacheGetJson,
   cacheSetJson,
   cacheInvalidate,
} from '../../utils/redis.utils';
import { compute24hVolume } from '../../utils/trading-volume.utils';
import { loadFeeTierConfig } from '../protocol/fee-tier.service';
import { fetchCurrentFeeBpsFromContract } from './key-swap-fee-contract';
import { KeyNotFoundError } from './key-fees.service';

export { KeyNotFoundError };

export interface SwapFeeTierResult {
   current_fee_bps: number;
   volume_bracket: string;
   rolling_24h_volume: string;
}

export interface KeyFeeHistoryRecord {
   id: string;
   key_id: string;
   keyId: string;
   fee_bps: number;
   feeBps: number;
   current_fee_bps: number;
   previous_fee_bps: number | null;
   previousFeeBps: number | null;
   volume_bracket: string | null;
   volumeBracket: string | null;
   rolling_24h_volume: string | null;
   rolling24hVolume: string | null;
   ledger: number;
   tx_hash: string;
   txHash: string;
   event_index: number;
   eventIndex: number;
   timestamp: string;
   created_at: string;
}

export const SWAP_FEE_CACHE_TTL_SECONDS = 60;

export function swapFeeCacheKey(keyId: string): string {
   return `key:swap-fee:${keyId}`;
}

/**
 * Returns the current swap fee tier for a given creator key.
 *
 * Sourced from the dynamic fee contract `get_current_fee_bps` call,
 * with 60s cache TTL and invalidation on FeeAdjusted events.
 */
export async function getSwapFeeTier(
   keyId: string
): Promise<SwapFeeTierResult> {
   const profile = await prisma.creatorProfile.findFirst({
      where: { OR: [{ id: keyId }, { handle: keyId }] },
      select: { id: true, handle: true },
   });

   if (!profile) {
      throw new KeyNotFoundError(keyId);
   }

   const cacheKey = swapFeeCacheKey(profile.id);
   const cached = await cacheGetJson<SwapFeeTierResult>(cacheKey);
   if (cached && typeof cached.current_fee_bps === 'number') {
      return cached;
   }

   // 1. Calculate 24h rolling volume
   const volume24h = await compute24hVolume(profile.id);

   // 2. Resolve volume bracket from configured fee tiers
   const tiers = await loadFeeTierConfig();
   const sortedTiers = [...tiers].sort(
      (a, b) => b.volumeThreshold - a.volumeThreshold
   );

   let activeTier = tiers[0];
   for (const tier of sortedTiers) {
      if (volume24h >= BigInt(tier.volumeThreshold)) {
         activeTier = tier;
         break;
      }
   }

   // 3. Read contract get_current_fee_bps, falling back to volume tier fee
   const contractFeeBps = await fetchCurrentFeeBpsFromContract(profile.id);
   const currentFeeBps =
      contractFeeBps !== null ? contractFeeBps : activeTier.feeBps;

   const result: SwapFeeTierResult = {
      current_fee_bps: currentFeeBps,
      volume_bracket: activeTier.label,
      rolling_24h_volume: volume24h.toString(),
   };

   // 4. Cache with 60s TTL
   await cacheSetJson(cacheKey, result, SWAP_FEE_CACHE_TTL_SECONDS);

   return result;
}

/**
 * Invalidate the 60s swap fee cache for a key (called on FeeAdjusted event).
 */
export async function invalidateKeyFeeCache(keyId: string): Promise<void> {
   const keysToInvalidate = [swapFeeCacheKey(keyId), `key:swap-fee:${keyId}`];
   await cacheInvalidate(...keysToInvalidate);
}

/**
 * Returns fee tier change history for a given creator key with timestamps.
 */
export async function getKeyFeeHistory(
   keyId: string,
   options?: { limit?: number; offset?: number }
): Promise<KeyFeeHistoryRecord[]> {
   const profile = await prisma.creatorProfile.findFirst({
      where: { OR: [{ id: keyId }, { handle: keyId }] },
      select: { id: true },
   });

   if (!profile) {
      throw new KeyNotFoundError(keyId);
   }

   const limit = options?.limit && options.limit > 0 ? options.limit : 50;
   const offset = options?.offset && options.offset >= 0 ? options.offset : 0;

   const records = await prisma.keyFeeHistory.findMany({
      where: { keyId: profile.id },
      orderBy: { timestamp: 'desc' },
      take: limit,
      skip: offset,
   });

   return records.map(r => ({
      id: r.id,
      key_id: r.keyId,
      keyId: r.keyId,
      fee_bps: r.feeBps,
      feeBps: r.feeBps,
      current_fee_bps: r.feeBps,
      previous_fee_bps: r.previousFeeBps,
      previousFeeBps: r.previousFeeBps,
      volume_bracket: r.volumeBracket,
      volumeBracket: r.volumeBracket,
      rolling_24h_volume: r.rolling24hVolume,
      rolling24hVolume: r.rolling24hVolume,
      ledger: r.ledger,
      tx_hash: r.txHash,
      txHash: r.txHash,
      event_index: r.eventIndex,
      eventIndex: r.eventIndex,
      timestamp:
         r.timestamp instanceof Date
            ? r.timestamp.toISOString()
            : String(r.timestamp),
      created_at:
         r.createdAt instanceof Date
            ? r.createdAt.toISOString()
            : String(r.createdAt),
   }));
}
