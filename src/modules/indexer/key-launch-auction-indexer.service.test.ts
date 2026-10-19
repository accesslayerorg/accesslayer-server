import {
   processKeyLaunchAuctionEvents,
   isKeyLaunchAuctionEventType,
} from './key-launch-auction-indexer.service';
import { prisma } from '../../utils/prisma.utils';
import * as launchAuctionService from '../keys/key-launch-auction.service';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      keyAuction: {
         upsert: jest.fn(),
         findFirst: jest.fn(),
         update: jest.fn(),
      },
      keyAuctionBid: {
         create: jest.fn(),
      },
   },
}));

jest.mock('../keys/key-launch-auction.service', () => ({
   invalidateKeyLaunchAuctionCache: jest.fn().mockResolvedValue(undefined),
}));

describe('key-launch-auction-indexer.service', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   describe('isKeyLaunchAuctionEventType', () => {
      it('correctly identifies key launch auction events', () => {
         expect(isKeyLaunchAuctionEventType('AuctionCreated')).toBe(true);
         expect(isKeyLaunchAuctionEventType('AUCTION_CREATED')).toBe(true);
         expect(isKeyLaunchAuctionEventType('BidPlaced')).toBe(true);
         expect(isKeyLaunchAuctionEventType('BID_PLACED')).toBe(true);
         expect(isKeyLaunchAuctionEventType('AuctionSettled')).toBe(true);
         expect(isKeyLaunchAuctionEventType('AUCTION_SETTLED')).toBe(true);
         expect(isKeyLaunchAuctionEventType('KEY_BOUGHT')).toBe(false);
         expect(isKeyLaunchAuctionEventType('UNKNOWN_EVENT')).toBe(false);
      });
   });

   describe('AuctionCreated', () => {
      it('upserts auction record and invalidates cache', async () => {
         const now = new Date();
         const endTime = new Date(Date.now() + 3600000);
         const event = {
            eventType: 'AuctionCreated',
            keyId: 'creator-1',
            auctionId: 'auc-1',
            reservePrice: '100.5',
            startTime: now.toISOString(),
            endTime: endTime.toISOString(),
            txHash: '0xabc1',
            eventIndex: 0,
         };

         (prisma as any).keyAuction.upsert.mockResolvedValue({
            id: 'auc-db-1',
            keyId: 'creator-1',
         });

         await processKeyLaunchAuctionEvents([event as any]);

         expect((prisma as any).keyAuction.upsert).toHaveBeenCalledWith({
            where: { keyId: 'creator-1' },
            update: expect.objectContaining({
               auctionId: 'auc-1',
               reservePrice: '100.5',
               status: 'ACTIVE',
            }),
            create: expect.objectContaining({
               keyId: 'creator-1',
               auctionId: 'auc-1',
               reservePrice: '100.5',
               status: 'ACTIVE',
            }),
         });
         expect(launchAuctionService.invalidateKeyLaunchAuctionCache).toHaveBeenCalledWith('creator-1');
      });
   });

   describe('BidPlaced', () => {
      it('records bid and updates highest bid if amount is higher', async () => {
         const auctionRecord = {
            id: 'auc-db-1',
            keyId: 'creator-1',
            auctionId: 'auc-1',
            highestBid: '100',
            reservePrice: '50',
         };
         (prisma as any).keyAuction.findFirst.mockResolvedValue(auctionRecord);
         (prisma as any).keyAuctionBid.create.mockResolvedValue({ id: 'bid-1' });
         (prisma as any).keyAuction.update.mockResolvedValue({ ...auctionRecord, highestBid: '150' });

         const event = {
            eventType: 'BidPlaced',
            auctionId: 'auc-1',
            bidder: 'wallet-bidder-1',
            amount: '150',
            txHash: '0xbid1',
            ledger: 1001,
            timestamp: new Date().toISOString(),
            eventIndex: 1,
         };

         await processKeyLaunchAuctionEvents([event as any]);

         expect((prisma as any).keyAuctionBid.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
               auctionId: 'auc-db-1',
               keyId: 'creator-1',
               bidder: 'wallet-bidder-1',
               amount: '150',
               txHash: '0xbid1',
            }),
         });
         expect((prisma as any).keyAuction.update).toHaveBeenCalledWith({
            where: { id: 'auc-db-1' },
            data: {
               highestBid: '150',
               highestBidder: 'wallet-bidder-1',
            },
         });
         expect(launchAuctionService.invalidateKeyLaunchAuctionCache).toHaveBeenCalledWith('creator-1');
      });

      it('records bid without lowering highest bid if lower bid is placed', async () => {
         const auctionRecord = {
            id: 'auc-db-1',
            keyId: 'creator-1',
            highestBid: '200',
            reservePrice: '50',
         };
         (prisma as any).keyAuction.findFirst.mockResolvedValue(auctionRecord);
         (prisma as any).keyAuctionBid.create.mockResolvedValue({ id: 'bid-2' });

         const event = {
            eventType: 'BidPlaced',
            keyId: 'creator-1',
            bidder: 'wallet-bidder-2',
            amount: '150',
            txHash: '0xbid2',
            eventIndex: 2,
         };

         await processKeyLaunchAuctionEvents([event as any]);

         expect((prisma as any).keyAuctionBid.create).toHaveBeenCalled();
         expect((prisma as any).keyAuction.update).not.toHaveBeenCalled();
         expect(launchAuctionService.invalidateKeyLaunchAuctionCache).toHaveBeenCalledWith('creator-1');
      });
   });

   describe('AuctionSettled', () => {
      it('marks auction settled and records clearing price and winner', async () => {
         const auctionRecord = {
            id: 'auc-db-1',
            keyId: 'creator-1',
            highestBid: '200',
            highestBidder: 'winner-wallet',
            reservePrice: '50',
         };
         (prisma as any).keyAuction.findFirst.mockResolvedValue(auctionRecord);
         (prisma as any).keyAuction.update.mockResolvedValue({
            ...auctionRecord,
            status: 'SETTLED',
            clearingPrice: '200',
         });

         const event = {
            eventType: 'AuctionSettled',
            keyId: 'creator-1',
            clearingPrice: '200',
            winner: 'winner-wallet',
            settledAt: new Date().toISOString(),
            txHash: '0xsettle',
            eventIndex: 3,
         };

         await processKeyLaunchAuctionEvents([event as any]);

         expect((prisma as any).keyAuction.update).toHaveBeenCalledWith({
            where: { id: 'auc-db-1' },
            data: expect.objectContaining({
               status: 'SETTLED',
               clearingPrice: '200',
               winner: 'winner-wallet',
            }),
         });
         expect(launchAuctionService.invalidateKeyLaunchAuctionCache).toHaveBeenCalledWith('creator-1');
      });
   });
});
