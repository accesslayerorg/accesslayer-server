// src/modules/indexer/key-spotlight-indexer.service.test.ts
import {
   processSpotlightEvents,
   isSpotlightEvent,
   parseDate,
} from './key-spotlight-indexer.service';
import { prisma } from '../../utils/prisma.utils';
import { cacheInvalidate } from '../../utils/redis.utils';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      spotlightAuction: {
         upsert: jest.fn(),
         findFirst: jest.fn(),
         findMany: jest.fn(),
      },
   },
}));

jest.mock('../../utils/redis.utils', () => ({
   cacheInvalidate: jest.fn().mockResolvedValue(undefined),
   cacheGetJson: jest.fn().mockResolvedValue(null),
   cacheSetJson: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
   },
}));

describe('key-spotlight-indexer.service', () => {
   const prismaMock = prisma as unknown as {
      spotlightAuction: {
         upsert: jest.Mock;
         findFirst: jest.Mock;
         findMany: jest.Mock;
      };
   };

   beforeEach(() => {
      jest.clearAllMocks();
      prismaMock.spotlightAuction.upsert.mockResolvedValue({});
   });

   describe('isSpotlightEvent', () => {
      it('recognizes SpotlightBidPlaced and SpotlightAwarded events', () => {
         expect(
            isSpotlightEvent({
               eventType: 'SpotlightBidPlaced',
               ledger: 1,
               txHash: 'tx1',
               eventIndex: 0,
            })
         ).toBe(true);
         expect(
            isSpotlightEvent({
               eventType: 'SPOTLIGHT_BID_PLACED',
               ledger: 1,
               txHash: 'tx1',
               eventIndex: 0,
            })
         ).toBe(true);
         expect(
            isSpotlightEvent({
               eventType: 'SpotlightAwarded',
               ledger: 1,
               txHash: 'tx1',
               eventIndex: 0,
            })
         ).toBe(true);
         expect(
            isSpotlightEvent({
               eventType: 'SPOTLIGHT_AWARDED',
               ledger: 1,
               txHash: 'tx1',
               eventIndex: 0,
            })
         ).toBe(true);
         expect(
            isSpotlightEvent({
               eventType: 'OTHER_EVENT',
               ledger: 1,
               txHash: 'tx1',
               eventIndex: 0,
            })
         ).toBe(false);
      });
   });

   describe('parseDate', () => {
      it('handles null, undefined, empty', () => {
         expect(parseDate(null)).toBeNull();
         expect(parseDate(undefined)).toBeNull();
         expect(parseDate('')).toBeNull();
      });

      it('handles Date object', () => {
         const now = new Date();
         expect(parseDate(now)).toEqual(now);
      });

      it('handles epoch seconds (< 1e12)', () => {
         const sec = 1792300000;
         expect(parseDate(sec)?.getTime()).toBe(sec * 1000);
      });

      it('handles epoch milliseconds (>= 1e12)', () => {
         const ms = 1792300000000;
         expect(parseDate(ms)?.getTime()).toBe(ms);
      });

      it('handles ISO string', () => {
         const iso = '2026-11-01T12:00:00.000Z';
         expect(parseDate(iso)?.toISOString()).toBe(iso);
      });
   });

   describe('processSpotlightEvents', () => {
      it('indexes SpotlightBidPlaced into spotlight_auctions table and invalidates slot bids cache', async () => {
         const event = {
            eventType: 'SpotlightBidPlaced',
            slotId: 'slot-1',
            keyId: 'key-100',
            bidder: 'GBIDDER1',
            bidAmount: '50.0',
            ledger: 3000,
            txHash: 'tx-bid-1',
            eventIndex: 0,
         };

         await processSpotlightEvents([event]);

         expect(prismaMock.spotlightAuction.upsert).toHaveBeenCalledTimes(1);
         expect(prismaMock.spotlightAuction.upsert).toHaveBeenCalledWith({
            where: {
               txHash_eventIndex: {
                  txHash: 'tx-bid-1',
                  eventIndex: 0,
               },
            },
            create: {
               slotId: 'slot-1',
               eventType: 'SpotlightBidPlaced',
               keyId: 'key-100',
               bidder: 'GBIDDER1',
               bidAmount: '50.0',
               isWinning: false,
               startsAt: null,
               expiresAt: null,
               ledger: 3000,
               txHash: 'tx-bid-1',
               eventIndex: 0,
            },
            update: expect.objectContaining({
               slotId: 'slot-1',
               keyId: 'key-100',
               bidAmount: '50.0',
               isWinning: false,
            }),
         });
         expect(cacheInvalidate).toHaveBeenCalledWith('spotlight:bids:slot-1');
      });

      it('indexes SpotlightAwarded into spotlight_auctions table and invalidates active/history cache', async () => {
         const event = {
            eventType: 'SpotlightAwarded',
            slotId: 'slot-1',
            winningKeyId: 'key-100',
            winningBidder: 'GBIDDER1',
            winningBid: '75.0',
            startsAt: '2026-11-01T00:00:00.000Z',
            expiresAt: '2026-11-01T01:00:00.000Z',
            ledger: 3050,
            txHash: 'tx-award-1',
            eventIndex: 1,
         };

         await processSpotlightEvents([event]);

         expect(prismaMock.spotlightAuction.upsert).toHaveBeenCalledTimes(1);
         expect(prismaMock.spotlightAuction.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
               where: {
                  txHash_eventIndex: {
                     txHash: 'tx-award-1',
                     eventIndex: 1,
                  },
               },
               create: expect.objectContaining({
                  slotId: 'slot-1',
                  eventType: 'SpotlightAwarded',
                  keyId: 'key-100',
                  bidder: 'GBIDDER1',
                  bidAmount: '75.0',
                  isWinning: true,
                  startsAt: new Date('2026-11-01T00:00:00.000Z'),
                  expiresAt: new Date('2026-11-01T01:00:00.000Z'),
               }),
            })
         );
         expect(cacheInvalidate).toHaveBeenCalledWith(
            'spotlight:active',
            'spotlight:bids:slot-1',
            'key:spotlight:history:key-100'
         );
      });

      it('skips events missing keyId', async () => {
         const event = {
            eventType: 'SpotlightBidPlaced',
            slotId: 'slot-1',
            ledger: 3100,
            txHash: 'tx-nokey',
            eventIndex: 0,
         };

         await processSpotlightEvents([event]);

         expect(prismaMock.spotlightAuction.upsert).not.toHaveBeenCalled();
      });
   });
});
