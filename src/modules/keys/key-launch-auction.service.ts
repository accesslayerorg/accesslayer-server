import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson, cacheInvalidate } from '../../utils/redis.utils';
import { logger } from '../../utils/logger.utils';
import {
   REDIS_KEYS,
   KEY_LAUNCH_AUCTION_ACTIVE_CACHE_TTL_SECONDS,
   KEY_LAUNCH_AUCTION_SETTLED_CACHE_TTL_SECONDS,
} from '../../constants/notifications.constants';
import { KeyNotFoundError } from './key-auction.service';

export { KeyNotFoundError };

export interface KeyLaunchAuctionStatusResponse {
   status: string;
   highest_bid: string | null;
   reserve: string | null;
   countdown: number;
   clearing_price: string | null;
}

export interface KeyLaunchAuctionBidItem {
   id: string;
   bidder: string;
   amount: string;
   txHash: string | null;
   blockNumber: string | null;
   timestamp: string;
}

export interface KeyLaunchAuctionBidsResponse {
   bids: KeyLaunchAuctionBidItem[];
   total: number;
   page: number;
   limit: number;
}

/**
 * Retrieves status, highest bid, reserve price, countdown, and clearing price for a key launch auction.
 * Cache TTL: 10s during active auction, 300s after settlement (#1117).
 */
export async function getKeyLaunchAuctionStatus(
   keyId: string
): Promise<KeyLaunchAuctionStatusResponse> {
   const cacheKey = REDIS_KEYS.keyLaunchAuction(keyId);
   const cached = await cacheGetJson<KeyLaunchAuctionStatusResponse>(cacheKey);
   if (cached !== null) {
      return cached;
   }

   const creator = await prisma.creatorProfile.findFirst({
      where: { OR: [{ id: keyId }, { handle: keyId }] },
      select: { id: true },
   });

   if (!creator) {
      throw new KeyNotFoundError(keyId);
   }

   const auction = await (prisma as any).keyAuction.findUnique({
      where: { keyId: creator.id },
   });

   if (!auction) {
      const fallback: KeyLaunchAuctionStatusResponse = {
         status: 'not_configured',
         highest_bid: null,
         reserve: null,
         countdown: 0,
         clearing_price: null,
      };
      await cacheSetJson(cacheKey, fallback, KEY_LAUNCH_AUCTION_ACTIVE_CACHE_TTL_SECONDS);
      return fallback;
   }

   const isActive = auction.status.toUpperCase() === 'ACTIVE';
   const now = Date.now();
   const endMs = new Date(auction.endTime).getTime();
   const countdown = isActive && endMs > now ? Math.ceil((endMs - now) / 1000) : 0;

   const result: KeyLaunchAuctionStatusResponse = {
      status: auction.status.toLowerCase(),
      highest_bid: auction.highestBid ? auction.highestBid.toString() : null,
      reserve: auction.reservePrice ? auction.reservePrice.toString() : null,
      countdown,
      clearing_price: auction.clearingPrice ? auction.clearingPrice.toString() : null,
   };

   const ttl = isActive
      ? KEY_LAUNCH_AUCTION_ACTIVE_CACHE_TTL_SECONDS
      : KEY_LAUNCH_AUCTION_SETTLED_CACHE_TTL_SECONDS;

   await cacheSetJson(cacheKey, result, ttl);
   return result;
}

/**
 * Retrieves paginated bids for a key launch auction sorted in descending order (#1117).
 */
export async function getKeyLaunchAuctionBids(
   keyId: string,
   options: { page?: number; limit?: number } = {}
): Promise<KeyLaunchAuctionBidsResponse> {
   const page = Math.max(1, Number(options.page) || 1);
   const limit = Math.min(100, Math.max(1, Number(options.limit) || 20));
   const skip = (page - 1) * limit;

   const cacheKey = REDIS_KEYS.keyLaunchAuctionBids(keyId, page, limit);
   const cached = await cacheGetJson<KeyLaunchAuctionBidsResponse>(cacheKey);
   if (cached !== null) {
      return cached;
   }

   const creator = await prisma.creatorProfile.findFirst({
      where: { OR: [{ id: keyId }, { handle: keyId }] },
      select: { id: true },
   });

   if (!creator) {
      throw new KeyNotFoundError(keyId);
   }

   const auction = await (prisma as any).keyAuction.findUnique({
      where: { keyId: creator.id },
      select: { id: true, status: true },
   });

   if (!auction) {
      const emptyResult: KeyLaunchAuctionBidsResponse = {
         bids: [],
         total: 0,
         page,
         limit,
      };
      await cacheSetJson(cacheKey, emptyResult, KEY_LAUNCH_AUCTION_ACTIVE_CACHE_TTL_SECONDS);
      return emptyResult;
   }

   const [bids, total] = await Promise.all([
      (prisma as any).keyAuctionBid.findMany({
         where: { auctionId: auction.id },
         orderBy: [{ amount: 'desc' }, { timestamp: 'desc' }],
         skip,
         take: limit,
      }),
      (prisma as any).keyAuctionBid.count({
         where: { auctionId: auction.id },
      }),
   ]);

   const mappedBids: KeyLaunchAuctionBidItem[] = bids.map((b: any) => ({
      id: b.id,
      bidder: b.bidder,
      amount: b.amount.toString(),
      txHash: b.txHash ?? null,
      blockNumber: b.blockNumber ? b.blockNumber.toString() : null,
      timestamp: b.timestamp ? new Date(b.timestamp).toISOString() : new Date().toISOString(),
   }));

   const result: KeyLaunchAuctionBidsResponse = {
      bids: mappedBids,
      total,
      page,
      limit,
   };

   const isActive = auction.status.toUpperCase() === 'ACTIVE';
   const ttl = isActive
      ? KEY_LAUNCH_AUCTION_ACTIVE_CACHE_TTL_SECONDS
      : KEY_LAUNCH_AUCTION_SETTLED_CACHE_TTL_SECONDS;

   await cacheSetJson(cacheKey, result, ttl);
   return result;
}

/**
 * Invalidates cache for a key launch auction.
 */
export async function invalidateKeyLaunchAuctionCache(keyId: string): Promise<void> {
   try {
      await cacheInvalidate(REDIS_KEYS.keyLaunchAuction(keyId));
      for (let p = 1; p <= 5; p++) {
         await cacheInvalidate(REDIS_KEYS.keyLaunchAuctionBids(keyId, p, 20));
      }
   } catch (error) {
      logger.warn({ error, keyId }, 'Failed to invalidate key launch auction cache');
   }
}
