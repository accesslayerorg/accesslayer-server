// src/modules/keys/key-twap.service.ts
// TWAP price calculation and caching service for creator keys (#963).
//
// - Time-weighted average over CreatorPriceHistory snapshots per window.
// - Redis cache with TTL matching the window size.
// - Read-through on cache miss; stale flag when the job is behind.

import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';
import { getBuyUnitPrice } from '../../utils/pricing.utils';
import {
   TWAP_CACHE_TTL_SECONDS,
   TWAP_MAX_SNAPSHOTS,
   TWAP_STALE_THRESHOLD_MS,
   TWAP_WINDOW_MS,
   twapRedisKey,
   type TwapWindow,
} from '../../constants/redis.constants';

export class KeyNotFoundError extends Error {
   constructor(keyId: string) {
      super(`Key not found: ${keyId}`);
      this.name = 'KeyNotFoundError';
   }
}

export interface TwapPriceResult {
   keyId: string;
   window: TwapWindow;
   /** TWAP in stroops (string to avoid JS precision loss). */
   twap: string;
   /** Bonding-curve spot price for the next buy unit, in stroops. */
   spotPrice: string;
   /**
    * Signed percentage difference from TWAP to spot:
    *   ((spotPrice - twap) / twap) * 100
    * Positive = spot above TWAP; negative = spot below TWAP.
    * 0 when falling back to spot with no history; null when TWAP is 0.
    */
   deltaPct: number | null;
   /** ISO-8601 timestamp of this computation. */
   computedAt: string;
   /** True when computedAt is older than TWAP_STALE_THRESHOLD_MS. */
   stale: boolean;
}

export interface TwapSnapshotPoint {
   timestamp: Date;
   price: bigint;
}

/**
 * Pure time-weighted average over carry-forward prices.
 *
 * priorPrice seeds [windowStart, firstSnapshot); when null, the first
 * in-window price fills the leading gap. Returns null when there is
 * no price information at all.
 */
export function computeTwapFromSnapshots(
   priorPrice: bigint | null,
   snapshots: TwapSnapshotPoint[],
   windowStartMs: number,
   nowMs: number
): bigint | null {
   const totalMs = nowMs - windowStartMs;
   if (totalMs <= 0) {
      return null;
   }
   if (snapshots.length === 0) {
      return priorPrice;
   }

   const ordered = [...snapshots].sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
   );

   let currentPrice: bigint | null = priorPrice ?? ordered[0].price;
   let prevTimeMs = windowStartMs;
   let weightedSum = 0n;

   for (const snapshot of ordered) {
      const snapshotMs = snapshot.timestamp.getTime();
      const durationMs = Math.max(0, snapshotMs - prevTimeMs);
      if (durationMs > 0 && currentPrice !== null) {
         weightedSum += currentPrice * BigInt(durationMs);
      }
      currentPrice = snapshot.price;
      prevTimeMs = Math.max(prevTimeMs, snapshotMs);
   }

   const tailMs = Math.max(0, nowMs - prevTimeMs);
   if (tailMs > 0 && currentPrice !== null) {
      weightedSum += currentPrice * BigInt(tailMs);
   }

   if (currentPrice === null) {
      return null;
   }
   return weightedSum / BigInt(totalMs);
}

/** Guarded delta: ((spot - twap) / twap) * 100, null when TWAP is 0. */
export function computeDeltaPct(
   spotPrice: bigint,
   twap: bigint
): number | null {
   if (twap === 0n) {
      return null;
   }
   const spot = Number(spotPrice);
   const base = Number(twap);
   if (!Number.isFinite(spot) || !Number.isFinite(base)) {
      return null;
   }
   return parseFloat((((spot - base) / base) * 100).toFixed(4));
}

type CreatorForTwap = {
   id: string;
   circulatingSupply: unknown;
   creatorRoyaltyBuyBps: number;
};

async function fetchCreatorForTwap(keyId: string): Promise<CreatorForTwap> {
   const creator = await prisma.creatorProfile.findFirst({
      where: { OR: [{ id: keyId }, { handle: keyId }] },
      select: {
         id: true,
         circulatingSupply: true,
         creatorRoyaltyBuyBps: true,
      },
   });
   if (!creator) {
      throw new KeyNotFoundError(keyId);
   }
   return creator as CreatorForTwap;
}

function getSpotForCreator(creator: CreatorForTwap): bigint {
   const supply = Number(creator.circulatingSupply?.toString() ?? '0');
   const safeSupply = Number.isFinite(supply)
      ? Math.max(0, Math.floor(supply))
      : 0;
   return getBuyUnitPrice(safeSupply, creator.creatorRoyaltyBuyBps);
}

/**
 * Compute TWAP for a key/window and refresh the Redis cache.
 * Falls back to spot (deltaPct = 0) when the key has 0 snapshots.
 */
export async function computeAndCacheTwap(
   keyId: string,
   window: TwapWindow,
   now: Date = new Date()
): Promise<TwapPriceResult> {
   const creator = await fetchCreatorForTwap(keyId);
   const nowMs = now.getTime();
   const windowStartMs = nowMs - TWAP_WINDOW_MS[window];
   const windowStart = new Date(windowStartMs);

   const prior = await prisma.creatorPriceHistory.findFirst({
      where: { creatorId: creator.id, recordedAt: { lt: windowStart } },
      orderBy: { recordedAt: 'desc' },
      select: { price: true, recordedAt: true },
   });

   const rows = await prisma.creatorPriceHistory.findMany({
      where: {
         creatorId: creator.id,
         recordedAt: { gte: windowStart, lte: now },
      },
      orderBy: { recordedAt: 'asc' },
      take: TWAP_MAX_SNAPSHOTS,
      select: { price: true, recordedAt: true },
   });

   const spotPrice = getSpotForCreator(creator);
   const hasHistory =
      (prior !== null && prior !== undefined) || rows.length > 0;

   let twap: bigint;
   let deltaPct: number | null;
   if (!hasHistory) {
      twap = spotPrice;
      deltaPct = 0;
   } else {
      const computed = computeTwapFromSnapshots(
         prior ? (prior.price as bigint) : null,
         rows.map((row: { price: bigint; recordedAt: Date }) => ({
            timestamp: row.recordedAt as Date,
            price: row.price as bigint,
         })),
         windowStartMs,
         nowMs
      );
      if (computed === null) {
         twap = spotPrice;
         deltaPct = 0;
      } else {
         twap = computed;
         deltaPct = computeDeltaPct(spotPrice, twap);
      }
   }

   const result: TwapPriceResult = {
      keyId: creator.id,
      window,
      twap: twap.toString(),
      spotPrice: spotPrice.toString(),
      deltaPct,
      computedAt: now.toISOString(),
      stale: false,
   };

   await cacheSetJson(
      twapRedisKey(creator.id, window),
      result,
      TWAP_CACHE_TTL_SECONDS[window]
   );
   return result;
}

/**
 * Read-through TWAP fetch: serve the cached value when present
 * (flagging stale when the job is behind), otherwise compute on demand.
 */
export async function getTwapPrice(
   keyId: string,
   window: TwapWindow,
   now: Date = new Date()
): Promise<TwapPriceResult> {
   const creator = await fetchCreatorForTwap(keyId);
   const cached = await cacheGetJson<TwapPriceResult>(
      twapRedisKey(creator.id, window)
   );
   if (cached !== null) {
      const ageMs = Date.now() - new Date(cached.computedAt).getTime();
      const stale = !Number.isFinite(ageMs) || ageMs > TWAP_STALE_THRESHOLD_MS;
      return { ...cached, keyId: creator.id, window, stale };
   }
   return computeAndCacheTwap(creator.id, window, now);
}
