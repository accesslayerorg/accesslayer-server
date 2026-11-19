import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';

export const ACTIVE_AUCTION_CACHE_TTL_SECONDS = 10;
export const SETTLED_AUCTION_CACHE_TTL_SECONDS = 300;
export const keyLaunchAuctionCacheKeys = {
   state: (keyId: string) => `keys:launch-auction:${keyId}`,
   bids: (keyId: string) => `keys:launch-auction:${keyId}:bids:*`,
};

type AuctionRow = {
   auctionId: string;
   keyId: string;
   status: string;
   reserve: unknown;
   highestBid: unknown;
   highestBidder: string | null;
   clearingPrice: unknown;
   startsAt: Date | string;
   endsAt: Date | string;
   settledAt: Date | string | null;
};

function formatAuction(row: AuctionRow, now: Date) {
   const endsAt = new Date(row.endsAt);
   return {
      auction_id: row.auctionId,
      key_id: row.keyId,
      status: row.status,
      highest_bid: row.highestBid == null ? null : String(row.highestBid),
      highest_bidder: row.highestBidder,
      reserve: String(row.reserve),
      starts_at: new Date(row.startsAt).toISOString(),
      ends_at: endsAt.toISOString(),
      countdown_seconds:
         row.status === 'active'
            ? Math.max(0, Math.ceil((endsAt.getTime() - now.getTime()) / 1000))
            : 0,
      clearing_price:
         row.clearingPrice == null ? null : String(row.clearingPrice),
      settled_at: row.settledAt ? new Date(row.settledAt).toISOString() : null,
   };
}

export async function getKeyLaunchAuction(keyId: string, now = new Date()) {
   const cacheKey = keyLaunchAuctionCacheKeys.state(keyId);
   let row = await cacheGetJson<AuctionRow>(cacheKey);
   if (!row) {
      row = (await prisma.keyLaunchAuction.findUnique({
         where: { keyId },
      })) as AuctionRow | null;
      if (!row) return null;
      await cacheSetJson(
         cacheKey,
         row,
         row.status === 'active'
            ? ACTIVE_AUCTION_CACHE_TTL_SECONDS
            : SETTLED_AUCTION_CACHE_TTL_SECONDS
      );
   }
   return formatAuction(row, now);
}

export async function getKeyLaunchAuctionBids(
   keyId: string,
   page = 1,
   limit = 20
) {
   const auction = await prisma.keyLaunchAuction.findUnique({
      where: { keyId },
      select: { auctionId: true },
   });
   if (!auction) return null;
   const [rows, total] = await Promise.all([
      prisma.keyLaunchAuctionBid.findMany({
         where: { auctionId: auction.auctionId },
         orderBy: [
            { amount: 'desc' },
            { placedAt: 'desc' },
            { eventIndex: 'desc' },
         ],
         skip: (page - 1) * limit,
         take: limit,
      }),
      prisma.keyLaunchAuctionBid.count({
         where: { auctionId: auction.auctionId },
      }),
   ]);
   return {
      bids: rows.map(row => ({
         bidder: row.bidder,
         amount: String(row.amount),
         placed_at: row.placedAt.toISOString(),
         tx_hash: row.txHash,
      })),
      pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
   };
}
