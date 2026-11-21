import { EventEmitter } from 'events';
import { prisma } from '../../utils/prisma.utils';

export const auctionEventEmitter = new EventEmitter();

export class AuctionNotFoundError extends Error {
   constructor(auctionId: string) {
      super(`Auction ${auctionId} not found`);
      this.name = 'AuctionNotFoundError';
   }
}

export class AuctionClosedError extends Error {
   constructor(auctionId: string) {
      super(`Auction ${auctionId} is closed`);
      this.name = 'AuctionClosedError';
   }
}

export class BidValidationError extends Error {
   constructor(message: string) {
      super(message);
      this.name = 'BidValidationError';
   }
}

export interface AuctionBidReadModel {
   id: string;
   auctionId: string;
   bidderId: string;
   amount: string;
   status: string;
   createdAt: Date;
}

export interface AuctionReadModel {
   id: string;
   keyId: string;
   status: string;
   minimumBid: string | number | null;
   minimumIncrement: string | number | null;
   currentBid: string | number | null;
   currentBidder: string | null;
   winnerWallet: string | null;
   createdAt: Date;
   updatedAt: Date;
}

function toNumber(value: string | number | null | undefined): number {
   if (value === null || value === undefined || value === '') {
      return 0;
   }
   const num = Number(value);
   return Number.isFinite(num) ? num : 0;
}

export function emitAuctionOutbidEvent(payload: {
   auctionId: string;
   previousBidder: string;
   newBidder: string;
   previousAmount: string;
   newAmount: string;
}): void {
   auctionEventEmitter.emit('auction_outbid', payload);
}

export async function getAuctionBids(
   auctionId: string
): Promise<AuctionBidReadModel[]> {
   const bids = await prisma.auctionBid.findMany({
      where: { auctionId },
      orderBy: [{ amount: 'desc' }, { createdAt: 'asc' }],
   });

   return bids.map((bid: any) => ({
      ...bid,
      amount: String(bid.amount),
   })) as AuctionBidReadModel[];
}

export async function submitBid(
   auctionId: string,
   bidderId: string,
   amount: string | number
): Promise<AuctionBidReadModel> {
   const auction = (await prisma.auction.findUnique({
      where: { id: auctionId },
   })) as AuctionReadModel | null;

   if (!auction) {
      throw new AuctionNotFoundError(auctionId);
   }

   if (auction.status !== 'OPEN') {
      throw new AuctionClosedError(auctionId);
   }

   const bidAmount = Number(amount);
   if (!Number.isFinite(bidAmount) || bidAmount <= 0) {
      throw new BidValidationError('Bid amount must be a positive number');
   }

   const currentBid = toNumber(auction.currentBid ?? auction.minimumBid ?? 0);
   const minimumIncrement = toNumber(auction.minimumIncrement ?? 0);
   const minimumAllowed = currentBid + minimumIncrement;
   if (bidAmount < minimumAllowed) {
      throw new BidValidationError(
         `Bid must be at least ${minimumAllowed} (${currentBid} + ${minimumIncrement})`
      );
   }

   const previousBidder = auction.currentBidder;
   const bid = (await prisma.$transaction(async (tx: any) => {
      const created = await tx.auctionBid.create({
         data: {
            auctionId,
            bidderId,
            amount: String(bidAmount),
            status: 'ACTIVE',
         },
      });

      await tx.auction.update({
         where: { id: auctionId },
         data: {
            currentBid: String(bidAmount),
            currentBidder: bidderId,
            updatedAt: new Date(),
         },
      });

      return created;
   })) as AuctionBidReadModel;

   if (previousBidder && previousBidder !== bidderId) {
      emitAuctionOutbidEvent({
         auctionId,
         previousBidder,
         newBidder: bidderId,
         previousAmount: String(currentBid),
         newAmount: String(bidAmount),
      });
   }

   return bid;
}

export async function closeAuction(auctionId: string): Promise<{ id: string; status: string; winnerWallet: string | null }> {
   const auction = (await prisma.auction.findUnique({
      where: { id: auctionId },
   })) as AuctionReadModel | null;

   if (!auction) {
      throw new AuctionNotFoundError(auctionId);
   }

   return prisma.$transaction(async (tx: any) => {
      const bids = await tx.auctionBid.findMany({
         where: { auctionId, status: 'ACTIVE' },
         orderBy: [{ amount: 'desc' }, { createdAt: 'asc' }],
      });

      const winnerBid = bids[0] ?? null;
      const losingBidIds = bids
         .filter((bid: { id: string }) => bid.id !== winnerBid?.id)
         .map((bid: { id: string }) => bid.id);

      if (losingBidIds.length > 0) {
         await tx.auctionBid.updateMany({
            where: { id: { in: losingBidIds } },
            data: {
               status: 'REFUNDED',
               refundedAt: new Date(),
            },
         });
      }

      await tx.auction.update({
         where: { id: auctionId },
         data: {
            status: 'CLOSED',
            winnerWallet: winnerBid?.bidderId ?? null,
            closedAt: new Date(),
            updatedAt: new Date(),
         },
      });

      if (auction.keyId && winnerBid) {
         await tx.registeredKey.update({
            where: { id: auction.keyId },
            data: { status: 'ACTIVE' },
         });
      }

      return {
         id: auctionId,
         status: 'CLOSED',
         winnerWallet: winnerBid?.bidderId ?? null,
      };
   });
}
