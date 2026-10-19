import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   processIndexerChainEvents,
   IndexerChainEvent,
} from '../../utils/indexer-event-processor.utils';
import { invalidateKeyLaunchAuctionCache } from '../keys/key-launch-auction.service';

export const KEY_LAUNCH_AUCTION_EVENT_TYPES = [
   'AuctionCreated',
   'AUCTION_CREATED',
   'BidPlaced',
   'BID_PLACED',
   'AuctionSettled',
   'AUCTION_SETTLED',
] as const;

export function isKeyLaunchAuctionEventType(eventType: string): boolean {
   return (KEY_LAUNCH_AUCTION_EVENT_TYPES as readonly string[]).includes(eventType);
}

export interface AuctionCreatedEvent extends IndexerChainEvent {
   keyId: string;
   auctionId?: string;
   reservePrice: string | number;
   startTime?: string | number | Date;
   endTime: string | number | Date;
}

export interface BidPlacedEvent extends IndexerChainEvent {
   keyId?: string;
   auctionId?: string;
   bidder: string;
   amount: string | number;
   txHash: string;
   ledger?: number;
   blockNumber?: number | bigint;
   timestamp?: string | number | Date;
}

export interface AuctionSettledEvent extends IndexerChainEvent {
   keyId?: string;
   auctionId?: string;
   clearingPrice: string | number;
   winner?: string;
   settledAt?: string | number | Date;
}

/**
 * Indexes key launch auction events into key_auctions and key_auction_bids (#1117).
 */
export async function processKeyLaunchAuctionEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   const auctionEvents = events.filter(e => isKeyLaunchAuctionEventType(e.eventType));
   if (auctionEvents.length === 0) return;

   await processIndexerChainEvents(auctionEvents, async rawEvent => {
      const eventType = rawEvent.eventType;

      if (eventType === 'AuctionCreated' || eventType === 'AUCTION_CREATED') {
         const event = rawEvent as unknown as AuctionCreatedEvent;
         const keyId = event.keyId || (rawEvent as any).creatorId;
         if (!keyId) {
            logger.warn({ rawEvent }, 'AuctionCreated missing keyId');
            return;
         }

         const auctionId = event.auctionId || `auction-${keyId}`;
         const startTime = event.startTime ? new Date(event.startTime) : new Date();
         const endTime = event.endTime ? new Date(event.endTime) : new Date(Date.now() + 86400000);
         const reservePrice = event.reservePrice ?? '0';

         await (prisma as any).keyAuction.upsert({
            where: { keyId },
            update: {
               auctionId,
               reservePrice: reservePrice.toString(),
               startTime,
               endTime,
               status: 'ACTIVE',
            },
            create: {
               keyId,
               auctionId,
               reservePrice: reservePrice.toString(),
               startTime,
               endTime,
               status: 'ACTIVE',
            },
         });

         await invalidateKeyLaunchAuctionCache(keyId);
         return;
      }

      if (eventType === 'BidPlaced' || eventType === 'BID_PLACED') {
         const event = rawEvent as unknown as BidPlacedEvent;
         const keyId = event.keyId || (rawEvent as any).creatorId;
         const auctionId = event.auctionId;

         let auction = await (prisma as any).keyAuction.findFirst({
            where: {
               OR: [
                  ...(keyId ? [{ keyId }] : []),
                  ...(auctionId ? [{ auctionId }, { id: auctionId }] : []),
               ],
            },
         });

         if (!auction) {
            logger.warn({ rawEvent }, 'BidPlaced event received for unknown auction');
            return;
         }

         const targetKeyId = auction.keyId;
         const bidAmount = event.amount.toString();
         const blockNum = event.blockNumber ?? event.ledger ?? null;

         await (prisma as any).keyAuctionBid.create({
            data: {
               auctionId: auction.id,
               keyId: targetKeyId,
               bidder: event.bidder,
               amount: bidAmount,
               txHash: event.txHash ?? null,
               blockNumber: blockNum !== null ? BigInt(blockNum) : null,
               timestamp: event.timestamp ? new Date(event.timestamp) : new Date(),
            },
         });

         const currentHighest = auction.highestBid ? Number(auction.highestBid) : 0;
         if (Number(bidAmount) >= currentHighest) {
            await (prisma as any).keyAuction.update({
               where: { id: auction.id },
               data: {
                  highestBid: bidAmount,
                  highestBidder: event.bidder,
               },
            });
         }

         await invalidateKeyLaunchAuctionCache(targetKeyId);
         return;
      }

      if (eventType === 'AuctionSettled' || eventType === 'AUCTION_SETTLED') {
         const event = rawEvent as unknown as AuctionSettledEvent;
         const keyId = event.keyId || (rawEvent as any).creatorId;
         const auctionId = event.auctionId;

         let auction = await (prisma as any).keyAuction.findFirst({
            where: {
               OR: [
                  ...(keyId ? [{ keyId }] : []),
                  ...(auctionId ? [{ auctionId }, { id: auctionId }] : []),
               ],
            },
         });

         if (!auction) {
            logger.warn({ rawEvent }, 'AuctionSettled event received for unknown auction');
            return;
         }

         const targetKeyId = auction.keyId;
         const clearingPrice = event.clearingPrice?.toString() ?? auction.highestBid?.toString() ?? auction.reservePrice.toString();
         const settledAt = event.settledAt ? new Date(event.settledAt) : new Date();

         await (prisma as any).keyAuction.update({
            where: { id: auction.id },
            data: {
               status: 'SETTLED',
               clearingPrice,
               winner: event.winner ?? auction.highestBidder ?? null,
               settledAt,
            },
         });

         await invalidateKeyLaunchAuctionCache(targetKeyId);
         return;
      }
   });
}
