// src/modules/keys/key-depth.service.ts
//
// Read side of GET /keys/:key_id/depth and /depth/spread (#1152). Serves the
// order book depth indexed from DepthUpdated events out of `key_depth`,
// fronted by a 5s cache that the indexer invalidates per key on every event.

import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';
import {
   KEY_DEPTH_CACHE_TTL_SECONDS,
   keyDepthCacheKey,
   keyDepthSpreadCacheKey,
} from '../../constants/redis.constants';

export const DEPTH_DEFAULT_LEVELS = 10;
export const DEPTH_MAX_LEVELS = 100;

export interface DepthLevel {
   /** Level price in stroops, as a string to avoid JS precision loss. */
   price: string;
   /** Total open volume at this level. */
   volume: string;
   /** Sum of volume from the best price down to and including this level. */
   cumulative_volume: string;
}

export interface KeyDepthResult {
   /** Highest price first. */
   bids: DepthLevel[];
   /** Lowest price first. */
   asks: DepthLevel[];
}

export interface KeySpreadResult {
   best_bid: string | null;
   best_ask: string | null;
   /** (best_bid + best_ask) / 2; ".5" when the sum is odd. Null if a side is empty. */
   mid_price: string | null;
   /** best_ask - best_bid. Null if a side is empty. */
   spread: string | null;
}

function withCumulative(
   rows: { price: bigint; volume: bigint }[]
): DepthLevel[] {
   let running = 0n;
   return rows.map(row => {
      running += row.volume;
      return {
         price: row.price.toString(),
         volume: row.volume.toString(),
         cumulative_volume: running.toString(),
      };
   });
}

/**
 * Top `levels` bid and ask levels for a key with cumulative volumes. Keys
 * with no open orders return empty sides.
 *
 * `creatorId` must be the canonical CreatorProfile id (not a handle) so the
 * cache key matches what the indexer invalidates.
 */
export async function getKeyDepth(
   creatorId: string,
   levels: number = DEPTH_DEFAULT_LEVELS
): Promise<KeyDepthResult> {
   const cacheKey = keyDepthCacheKey(creatorId, levels);
   const cached = await cacheGetJson<KeyDepthResult>(cacheKey);
   if (cached !== null) return cached;

   const select = { price: true, volume: true };
   const [bids, asks] = await Promise.all([
      prisma.keyDepth.findMany({
         where: { creatorId, side: 'bid', volume: { gt: 0n } },
         orderBy: { price: 'desc' },
         take: levels,
         select,
      }),
      prisma.keyDepth.findMany({
         where: { creatorId, side: 'ask', volume: { gt: 0n } },
         orderBy: { price: 'asc' },
         take: levels,
         select,
      }),
   ]);

   const result: KeyDepthResult = {
      bids: withCumulative(bids),
      asks: withCumulative(asks),
   };
   await cacheSetJson(cacheKey, result, KEY_DEPTH_CACHE_TTL_SECONDS);
   return result;
}

function formatMid(bid: bigint, ask: bigint): string {
   const sum = bid + ask;
   return sum % 2n === 0n ? (sum / 2n).toString() : `${sum / 2n}.5`;
}

/** Best bid, best ask, mid-price and spread; nulls when a side is empty. */
export async function getKeySpread(
   creatorId: string
): Promise<KeySpreadResult> {
   const cacheKey = keyDepthSpreadCacheKey(creatorId);
   const cached = await cacheGetJson<KeySpreadResult>(cacheKey);
   if (cached !== null) return cached;

   const [bestBid, bestAsk] = await Promise.all([
      prisma.keyDepth.findFirst({
         where: { creatorId, side: 'bid', volume: { gt: 0n } },
         orderBy: { price: 'desc' },
         select: { price: true },
      }),
      prisma.keyDepth.findFirst({
         where: { creatorId, side: 'ask', volume: { gt: 0n } },
         orderBy: { price: 'asc' },
         select: { price: true },
      }),
   ]);

   const result: KeySpreadResult = {
      best_bid: bestBid?.price.toString() ?? null,
      best_ask: bestAsk?.price.toString() ?? null,
      mid_price:
         bestBid && bestAsk ? formatMid(bestBid.price, bestAsk.price) : null,
      spread:
         bestBid && bestAsk ? (bestAsk.price - bestBid.price).toString() : null,
   };
   await cacheSetJson(cacheKey, result, KEY_DEPTH_CACHE_TTL_SECONDS);
   return result;
}
