// src/modules/spotlight/spotlight.service.test.ts
import {
   getActiveSpotlight,
   getSpotlightBidsForSlot,
   getKeySpotlightHistory,
} from './spotlight.service';
import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      spotlightAuction: {
         findFirst: jest.fn(),
         findMany: jest.fn(),
      },
   },
}));

jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn(),
   cacheSetJson: jest.fn(),
   cacheInvalidate: jest.fn(),
}));

describe('spotlight.service', () => {
   const prismaMock = prisma as unknown as {
      spotlightAuction: {
         findFirst: jest.Mock;
         findMany: jest.Mock;
      };
   };
   const mockCacheGetJson = cacheGetJson as jest.Mock;
   const mockCacheSetJson = cacheSetJson as jest.Mock;

   beforeEach(() => {
      jest.clearAllMocks();
      mockCacheGetJson.mockResolvedValue(null);
      mockCacheSetJson.mockResolvedValue(undefined);
   });

   describe('getActiveSpotlight', () => {
      it('returns active spotlight winner with dynamic remaining duration and winning bid', async () => {
         const now = Date.now();
         const futureExpires = new Date(now + 90 * 1000); // 90 seconds from now

         prismaMock.spotlightAuction.findFirst.mockResolvedValue({
            id: 'spot-1',
            slotId: 'slot-alpha',
            keyId: 'creator-spotlight',
            bidder: 'GWINNER1',
            bidAmount: '120.0',
            isWinning: true,
            startsAt: new Date(now - 10 * 1000),
            expiresAt: futureExpires,
            ledger: 1000,
            txHash: 'tx-win-1',
            createdAt: new Date(),
         });

         const result = await getActiveSpotlight();

         expect(result.active).toBe(true);
         expect(result.slot_id).toBe('slot-alpha');
         expect(result.winning_key_id).toBe('creator-spotlight');
         expect(result.winning_bid).toBe('120.0');
         expect(result.winning_bidder).toBe('GWINNER1');
         expect(result.remaining_duration).toBeGreaterThanOrEqual(88);
         expect(result.remaining_duration).toBeLessThanOrEqual(91);
         expect(result.remaining_duration_seconds).toBe(result.remaining_duration);

         expect(mockCacheSetJson).toHaveBeenCalledWith(
            'spotlight:active',
            expect.any(Object),
            30
         );
      });

      it('returns active: false when no active award exists', async () => {
         prismaMock.spotlightAuction.findFirst.mockResolvedValue(null);

         const result = await getActiveSpotlight();

         expect(result.active).toBe(false);
         expect(result.winning_key_id).toBeNull();
         expect(result.winning_bid).toBeNull();
         expect(result.remaining_duration).toBeNull();
      });

      it('recomputes remaining duration dynamically even on cache hit', async () => {
         const now = Date.now();
         const futureExpires = new Date(now + 25 * 1000).toISOString();

         mockCacheGetJson.mockResolvedValue({
            active: true,
            slot_id: 'slot-cached',
            winning_key_id: 'creator-cached',
            winning_bid: '100.0',
            remaining_duration: 999,
            expires_at: futureExpires,
         });

         const result = await getActiveSpotlight();

         expect(prismaMock.spotlightAuction.findFirst).not.toHaveBeenCalled();
         expect(result.remaining_duration).toBeGreaterThanOrEqual(23);
         expect(result.remaining_duration).toBeLessThanOrEqual(26);
      });
   });

   describe('getSpotlightBidsForSlot', () => {
      it('returns bids sorted in descending order of bid amount', async () => {
         prismaMock.spotlightAuction.findMany.mockResolvedValue([
            {
               id: 'bid-1',
               slotId: 'slot-1',
               keyId: 'key-1',
               bidder: 'GBIDDER1',
               bidAmount: '30.0',
               isWinning: false,
               ledger: 100,
               txHash: 'tx-1',
               eventIndex: 0,
               createdAt: new Date('2026-10-19T00:00:00.000Z'),
            },
            {
               id: 'bid-2',
               slotId: 'slot-1',
               keyId: 'key-2',
               bidder: 'GBIDDER2',
               bidAmount: '100.0',
               isWinning: false,
               ledger: 101,
               txHash: 'tx-2',
               eventIndex: 0,
               createdAt: new Date('2026-10-19T00:05:00.000Z'),
            },
         ]);

         const bids = await getSpotlightBidsForSlot('slot-1');

         expect(bids).toHaveLength(2);
         // 100.0 must be first, then 30.0
         expect(bids[0].bid_amount).toBe('100.0');
         expect(bids[1].bid_amount).toBe('30.0');
         expect(mockCacheSetJson).toHaveBeenCalledWith(
            'spotlight:bids:slot-1',
            expect.any(Array),
            30
         );
      });
   });

   describe('getKeySpotlightHistory', () => {
      it('returns past spotlight wins for the key', async () => {
         prismaMock.spotlightAuction.findMany.mockResolvedValue([
            {
               id: 'win-1',
               slotId: 'slot-past-1',
               keyId: 'key-hist',
               bidder: 'GWIN',
               bidAmount: '80.0',
               isWinning: true,
               startsAt: new Date('2026-10-18T10:00:00.000Z'),
               expiresAt: new Date('2026-10-18T11:00:00.000Z'),
               ledger: 500,
               txHash: 'tx-win',
               createdAt: new Date('2026-10-18T10:00:00.000Z'),
            },
         ]);

         const history = await getKeySpotlightHistory('key-hist');

         expect(prismaMock.spotlightAuction.findMany).toHaveBeenCalledWith({
            where: {
               keyId: 'key-hist',
               isWinning: true,
            },
            orderBy: [{ createdAt: 'desc' }, { ledger: 'desc' }],
         });

         expect(history).toHaveLength(1);
         expect(history[0]).toMatchObject({
            slot_id: 'slot-past-1',
            key_id: 'key-hist',
            winning_bid: '80.0',
            winning_bidder: 'GWIN',
         });
         expect(mockCacheSetJson).toHaveBeenCalledWith(
            'key:spotlight:history:key-hist',
            expect.any(Array),
            30
         );
      });
   });
});
