// src/modules/spotlight/spotlight.service.ts
//
// Spotlight auction active winner, bid history, and key spotlight history service (#1114).

import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';

export const SPOTLIGHT_CACHE_TTL_SECONDS = 30;

export interface ActiveSpotlightResponse {
   active: boolean;
   slot_id: string | null;
   slotId?: string | null;
   winning_key_id: string | null;
   winningKeyId?: string | null;
   key_id: string | null;
   keyId?: string | null;
   winning_bid: string | null;
   winningBid?: string | null;
   winning_bidder: string | null;
   winningBidder?: string | null;
   remaining_duration_seconds: number | null;
   remaining_duration: number | null;
   remainingDuration?: number | null;
   starts_at: string | null;
   startsAt?: string | null;
   expires_at: string | null;
   expiresAt?: string | null;
}

export interface SpotlightBidResponse {
   id: string;
   slot_id: string;
   slotId?: string;
   key_id: string;
   keyId?: string;
   bidder: string | null;
   bid_amount: string | null;
   bidAmount?: string | null;
   is_winning: boolean;
   isWinning?: boolean;
   ledger: number;
   tx_hash: string;
   txHash?: string;
   event_index: number;
   eventIndex?: number;
   created_at: string;
   createdAt?: string;
}

export interface KeySpotlightHistoryItem {
   id: string;
   slot_id: string;
   slotId?: string;
   key_id: string;
   keyId?: string;
   winning_bid: string | null;
   winningBid?: string | null;
   winning_bidder: string | null;
   winningBidder?: string | null;
   starts_at: string | null;
   startsAt?: string | null;
   expires_at: string | null;
   expiresAt?: string | null;
   ledger: number;
   tx_hash: string;
   txHash?: string;
   awarded_at: string;
   awardedAt?: string;
}

/**
 * Returns the currently active spotlight winner, remaining duration, and winning bid.
 * Cached for 30 seconds; dynamically recalculates remaining duration on cache hit.
 */
export async function getActiveSpotlight(): Promise<ActiveSpotlightResponse> {
   const cacheKey = 'spotlight:active';
   const cached = await cacheGetJson<ActiveSpotlightResponse>(cacheKey);
   if (cached !== null) {
      if (cached.expires_at) {
         const diffMs = new Date(cached.expires_at).getTime() - Date.now();
         const remaining = Math.max(0, Math.floor(diffMs / 1000));
         return {
            ...cached,
            remaining_duration_seconds: remaining,
            remaining_duration: remaining,
            remainingDuration: remaining,
         };
      }
      return cached;
   }

   const now = new Date();
   const active = await prisma.spotlightAuction.findFirst({
      where: {
         isWinning: true,
         expiresAt: { gt: now },
      },
      orderBy: [{ expiresAt: 'desc' }, { createdAt: 'desc' }],
   });

   if (!active) {
      const inactiveResponse: ActiveSpotlightResponse = {
         active: false,
         slot_id: null,
         slotId: null,
         winning_key_id: null,
         winningKeyId: null,
         key_id: null,
         keyId: null,
         winning_bid: null,
         winningBid: null,
         winning_bidder: null,
         winningBidder: null,
         remaining_duration_seconds: null,
         remaining_duration: null,
         remainingDuration: null,
         starts_at: null,
         startsAt: null,
         expires_at: null,
         expiresAt: null,
      };
      await cacheSetJson(cacheKey, inactiveResponse, SPOTLIGHT_CACHE_TTL_SECONDS);
      return inactiveResponse;
   }

   let remaining: number | null = null;
   if (active.expiresAt) {
      remaining = Math.max(0, Math.floor((active.expiresAt.getTime() - Date.now()) / 1000));
   }

   const isoStarts = active.startsAt ? active.startsAt.toISOString() : null;
   const isoExpires = active.expiresAt ? active.expiresAt.toISOString() : null;

   const response: ActiveSpotlightResponse = {
      active: true,
      slot_id: active.slotId,
      slotId: active.slotId,
      winning_key_id: active.keyId,
      winningKeyId: active.keyId,
      key_id: active.keyId,
      keyId: active.keyId,
      winning_bid: active.bidAmount,
      winningBid: active.bidAmount,
      winning_bidder: active.bidder,
      winningBidder: active.bidder,
      remaining_duration_seconds: remaining,
      remaining_duration: remaining,
      remainingDuration: remaining,
      starts_at: isoStarts,
      startsAt: isoStarts,
      expires_at: isoExpires,
      expiresAt: isoExpires,
   };

   await cacheSetJson(cacheKey, response, SPOTLIGHT_CACHE_TTL_SECONDS);
   return response;
}

/**
 * Returns all bids for a slot in descending order (highest bid amount first).
 */
export async function getSpotlightBidsForSlot(
   slotId: string
): Promise<SpotlightBidResponse[]> {
   const cacheKey = `spotlight:bids:${slotId}`;
   const cached = await cacheGetJson<SpotlightBidResponse[]>(cacheKey);
   if (cached !== null) {
      return cached;
   }

   const bids = await prisma.spotlightAuction.findMany({
      where: { slotId },
      orderBy: [{ createdAt: 'desc' }, { ledger: 'desc' }, { eventIndex: 'desc' }],
   });

   const sortedBids = [...bids].sort((a, b) => {
      const numA = Number(a.bidAmount || 0);
      const numB = Number(b.bidAmount || 0);
      if (numA !== numB) {
         return numB - numA;
      }
      return b.createdAt.getTime() - a.createdAt.getTime();
   });

   const result: SpotlightBidResponse[] = sortedBids.map(b => ({
      id: b.id,
      slot_id: b.slotId,
      slotId: b.slotId,
      key_id: b.keyId,
      keyId: b.keyId,
      bidder: b.bidder,
      bid_amount: b.bidAmount,
      bidAmount: b.bidAmount,
      is_winning: b.isWinning,
      isWinning: b.isWinning,
      ledger: b.ledger,
      tx_hash: b.txHash,
      txHash: b.txHash,
      event_index: b.eventIndex,
      eventIndex: b.eventIndex,
      created_at: b.createdAt.toISOString(),
      createdAt: b.createdAt.toISOString(),
   }));

   await cacheSetJson(cacheKey, result, SPOTLIGHT_CACHE_TTL_SECONDS);
   return result;
}

/**
 * Returns a key's past spotlight wins ordered chronologically descending.
 */
export async function getKeySpotlightHistory(
   keyId: string
): Promise<KeySpotlightHistoryItem[]> {
   const cacheKey = `key:spotlight:history:${keyId}`;
   const cached = await cacheGetJson<KeySpotlightHistoryItem[]>(cacheKey);
   if (cached !== null) {
      return cached;
   }

   const wins = await prisma.spotlightAuction.findMany({
      where: {
         keyId,
         isWinning: true,
      },
      orderBy: [{ createdAt: 'desc' }, { ledger: 'desc' }],
   });

   const result: KeySpotlightHistoryItem[] = wins.map(w => ({
      id: w.id,
      slot_id: w.slotId,
      slotId: w.slotId,
      key_id: w.keyId,
      keyId: w.keyId,
      winning_bid: w.bidAmount,
      winningBid: w.bidAmount,
      winning_bidder: w.bidder,
      winningBidder: w.bidder,
      starts_at: w.startsAt ? w.startsAt.toISOString() : null,
      startsAt: w.startsAt ? w.startsAt.toISOString() : null,
      expires_at: w.expiresAt ? w.expiresAt.toISOString() : null,
      expiresAt: w.expiresAt ? w.expiresAt.toISOString() : null,
      ledger: w.ledger,
      tx_hash: w.txHash,
      txHash: w.txHash,
      awarded_at: w.createdAt.toISOString(),
      awardedAt: w.createdAt.toISOString(),
   }));

   await cacheSetJson(cacheKey, result, SPOTLIGHT_CACHE_TTL_SECONDS);
   return result;
}
