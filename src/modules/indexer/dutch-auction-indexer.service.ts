import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   IndexerChainEvent,
   processIndexerChainEvents,
} from '../../utils/indexer-event-processor.utils';
import { toStroops } from '../dutch-auctions/dutch-auction-price';

export const DUTCH_AUCTION_STARTED_EVENT_TYPES = new Set([
   'auction_started',
   'AuctionStarted',
   'AUCTION_STARTED',
]);
export const DUTCH_AUCTION_FILLED_EVENT_TYPES = new Set([
   'auction_filled',
   'AuctionFilled',
   'AUCTION_FILLED',
]);
export const DUTCH_AUCTION_CANCELLED_EVENT_TYPES = new Set([
   'auction_cancelled',
   'AuctionCancelled',
   'AUCTION_CANCELLED',
]);

export const DUTCH_AUCTION_EVENT_TYPES = new Set([
   ...DUTCH_AUCTION_STARTED_EVENT_TYPES,
   ...DUTCH_AUCTION_FILLED_EVENT_TYPES,
   ...DUTCH_AUCTION_CANCELLED_EVENT_TYPES,
]);

function requiredString(event: IndexerChainEvent, ...fields: string[]): string {
   for (const field of fields) {
      const value = event[field];
      if (value != null && String(value).trim() !== '') {
         return String(value).trim();
      }
   }
   throw new Error(`Invalid ${event.eventType}: ${fields[0]} is required`);
}

function positiveInt(event: IndexerChainEvent, ...fields: string[]): number {
   const raw = requiredString(event, ...fields);
   const value = Number(raw);
   if (!Number.isInteger(value) || value <= 0) {
      throw new Error(
         `Invalid ${event.eventType}: ${fields[0]} must be a positive integer`
      );
   }
   return value;
}

function priceString(event: IndexerChainEvent, ...fields: string[]): string {
   const raw = requiredString(event, ...fields);
   try {
      toStroops(raw);
   } catch {
      throw new Error(
         `Invalid ${event.eventType}: ${fields[0]} is not a valid price`
      );
   }
   return raw;
}

async function handleStarted(event: IndexerChainEvent): Promise<void> {
   const id = requiredString(event, 'auctionId', 'id');
   const quantity = positiveInt(event, 'quantity');
   const startPrice = priceString(event, 'startPrice');
   const floorPrice = priceString(event, 'floorPrice');
   if (toStroops(floorPrice) > toStroops(startPrice)) {
      throw new Error(
         `Invalid ${event.eventType}: floorPrice must not exceed startPrice`
      );
   }
   const durationLedgers = positiveInt(event, 'durationLedgers', 'duration');
   const startLedger = Number(event.startLedger ?? event.ledger ?? Number.NaN);
   if (!Number.isInteger(startLedger) || startLedger < 0) {
      throw new Error(`Invalid ${event.eventType}: startLedger is required`);
   }

   // Create-only: a replayed or repeated start never rewrites a later state.
   await prisma.dutchAuction.upsert({
      where: { id },
      create: {
         id,
         seller: requiredString(event, 'seller'),
         keyId: requiredString(event, 'keyId'),
         quantity,
         remaining: quantity,
         startPrice,
         floorPrice,
         startLedger,
         durationLedgers,
         status: 'open',
         startTxHash: event.txHash,
         startEventIndex: event.eventIndex,
      },
      update: {},
   });
}

async function handleFilled(event: IndexerChainEvent): Promise<void> {
   const id = requiredString(event, 'auctionId', 'id');
   const quantity = positiveInt(event, 'quantity', 'filled', 'amount');

   await prisma.$transaction(async (tx: any) => {
      const auction = await tx.dutchAuction.findUnique({ where: { id } });
      if (!auction) {
         throw new Error(`${event.eventType} references unknown auction ${id}`);
      }

      // The unique (txHash, eventIndex) row makes a replayed fill a no-op.
      const created = await tx.dutchAuctionFill.createMany({
         data: [
            {
               auctionId: id,
               buyer: event.buyer == null ? null : String(event.buyer),
               quantity,
               txHash: event.txHash,
               eventIndex: event.eventIndex,
               ledger: Number(event.ledger ?? 0),
            },
         ],
         skipDuplicates: true,
      });
      if (!created || created.count === 0) return;

      if (auction.status === 'cancelled') {
         logger.warn(
            { type: 'dutch_auction_fill_after_cancel', auctionId: id },
            'Fill recorded for a cancelled auction; state left unchanged'
         );
         return;
      }

      const remaining = Math.max(0, auction.remaining - quantity);
      await tx.dutchAuction.update({
         where: { id },
         data: {
            remaining,
            fillCount: { increment: 1 },
            // The chain is authoritative: a fill reopens an auction we had
            // marked ended, and exhausting the quantity completes it.
            status: remaining === 0 ? 'filled' : 'open',
         },
      });
   });
}

async function handleCancelled(event: IndexerChainEvent): Promise<void> {
   const id = requiredString(event, 'auctionId', 'id');
   // Only open or ended auctions can become cancelled; repeats and filled
   // auctions match nothing, so this is idempotent.
   await prisma.dutchAuction.updateMany({
      where: { id, status: { in: ['open', 'ended'] } },
      data: { status: 'cancelled' },
   });
}

export async function processDutchAuctionEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (DUTCH_AUCTION_STARTED_EVENT_TYPES.has(event.eventType)) {
         await handleStarted(event);
      } else if (DUTCH_AUCTION_FILLED_EVENT_TYPES.has(event.eventType)) {
         await handleFilled(event);
      } else if (DUTCH_AUCTION_CANCELLED_EVENT_TYPES.has(event.eventType)) {
         await handleCancelled(event);
      }
   });
}
