import { prisma } from '../../utils/prisma.utils';
import { cacheInvalidate } from '../../utils/redis.utils';
import {
   IndexerChainEvent,
   processIndexerChainEvents,
} from '../../utils/indexer-event-processor.utils';
import { keyLaunchAuctionCacheKeys } from '../keys/key-launch-auction.service';

export const KEY_LAUNCH_AUCTION_EVENT_TYPES = new Set([
   'AuctionCreated',
   'AUCTION_CREATED',
   'BidPlaced',
   'BID_PLACED',
   'AuctionSettled',
   'AUCTION_SETTLED',
]);

function auctionDate(value: unknown, fallback = new Date()): Date {
   const numeric = Number(value);
   if (
      value != null &&
      value !== '' &&
      Number.isFinite(numeric) &&
      /^\d+$/.test(String(value))
   ) {
      const result = new Date(numeric < 1e12 ? numeric * 1000 : numeric);
      if (!Number.isNaN(result.getTime())) return result;
   }
   const result = value ? new Date(String(value)) : fallback;
   return Number.isNaN(result.getTime()) ? fallback : result;
}

export async function processKeyLaunchAuctionEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (!KEY_LAUNCH_AUCTION_EVENT_TYPES.has(event.eventType)) return;
      let keyId = String(event.keyId ?? event.creatorId ?? '').trim();
      const auctionId = String(event.auctionId ?? keyId).trim();
      if (!auctionId)
         throw new Error(`Invalid ${event.eventType}: auctionId is required`);
      const isCreated =
         event.eventType === 'AuctionCreated' ||
         event.eventType === 'AUCTION_CREATED';
      const isBid =
         event.eventType === 'BidPlaced' || event.eventType === 'BID_PLACED';

      if (!isCreated && !keyId) {
         const auction = await prisma.keyLaunchAuction.findUnique({
            where: { auctionId },
            select: { keyId: true },
         });
         if (!auction) {
            throw new Error(
               `${event.eventType} references unknown auction ${auctionId}`
            );
         }
         keyId = auction.keyId;
      }
      if (!keyId)
         throw new Error(`Invalid ${event.eventType}: keyId is required`);

      if (isCreated) {
         const startsAt = auctionDate(
            event.startsAt ?? event.startTime ?? event.occurredAt
         );
         await prisma.keyLaunchAuction.upsert({
            where: { auctionId },
            create: {
               auctionId,
               keyId,
               status: 'active',
               reserve: String(event.reserve ?? event.reservePrice ?? 0),
               startsAt,
               endsAt: auctionDate(event.endsAt ?? event.endTime, startsAt),
               createdTxHash: event.txHash,
               createdEventIndex: event.eventIndex,
               ledger: Number(event.ledger ?? 0),
            },
            update: {},
         });
      } else if (isBid) {
         const bidder = String(
            event.bidder ?? event.wallet ?? event.actor ?? ''
         ).trim();
         const amount = String(event.amount ?? event.bidAmount ?? '');
         if (!bidder || !amount || !Number.isFinite(Number(amount)))
            throw new Error(
               `Invalid ${event.eventType}: bidder and amount are required`
            );
         await prisma.$transaction(async tx => {
            await tx.keyLaunchAuctionBid.upsert({
               where: {
                  txHash_eventIndex: {
                     txHash: event.txHash,
                     eventIndex: event.eventIndex,
                  },
               },
               create: {
                  auctionId,
                  bidder,
                  amount,
                  placedAt: auctionDate(
                     event.placedAt ?? event.occurredAt ?? event.timestamp
                  ),
                  txHash: event.txHash,
                  eventIndex: event.eventIndex,
                  ledger: Number(event.ledger ?? 0),
               },
               update: {},
            });
            const current = await tx.keyLaunchAuction.findUnique({
               where: { auctionId },
               select: { highestBid: true },
            });
            if (!current)
               throw new Error(
                  `BidPlaced references unknown auction ${auctionId}`
               );
            if (
               current.highestBid == null ||
               Number(amount) > Number(current.highestBid)
            ) {
               await tx.keyLaunchAuction.update({
                  where: { auctionId },
                  data: {
                     highestBid: amount,
                     highestBidder: bidder,
                     ledger: Number(event.ledger ?? 0),
                  },
               });
            }
         });
      } else {
         const existing = await prisma.keyLaunchAuction.findUnique({
            where: { auctionId },
            select: { settledTxHash: true, settledEventIndex: true },
         });
         if (!existing) {
            throw new Error(
               `${event.eventType} references unknown auction ${auctionId}`
            );
         }
         if (
            existing.settledTxHash === event.txHash &&
            existing.settledEventIndex === event.eventIndex
         ) {
            await cacheInvalidate(
               keyLaunchAuctionCacheKeys.state(keyId),
               keyLaunchAuctionCacheKeys.bids(keyId)
            );
            return;
         }
         await prisma.keyLaunchAuction.update({
            where: { auctionId },
            data: {
               status: 'settled',
               clearingPrice: String(event.clearingPrice ?? event.price ?? 0),
               settledAt: auctionDate(
                  event.settledAt ?? event.occurredAt ?? event.timestamp
               ),
               settledTxHash: event.txHash,
               settledEventIndex: event.eventIndex,
               ledger: Number(event.ledger ?? 0),
            },
         });
      }
      await cacheInvalidate(
         keyLaunchAuctionCacheKeys.state(keyId),
         keyLaunchAuctionCacheKeys.bids(keyId)
      );
   });
}
