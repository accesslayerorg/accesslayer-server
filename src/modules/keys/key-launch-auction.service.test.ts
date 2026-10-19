const redisStore = new Map<string, { value: string; ttl: number }>();

jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn(async (key: string) => {
      const entry = redisStore.get(key);
      if (!entry) return null;
      try {
         return JSON.parse(entry.value);
      } catch {
         return null;
      }
   }),
   cacheSetJson: jest.fn(async (key: string, value: unknown, ttl: number) => {
      redisStore.set(key, { value: JSON.stringify(value), ttl });
   }),
   cacheInvalidate: jest.fn(async (...keys: string[]) => {
      for (const key of keys) redisStore.delete(key);
   }),
}));

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      creatorProfile: {
         findFirst: jest.fn(),
      },
      keyAuction: {
         findUnique: jest.fn(),
      },
      keyAuctionBid: {
         findMany: jest.fn(),
         count: jest.fn(),
      },
   },
}));

import { prisma } from '../../utils/prisma.utils';
import {
   getKeyLaunchAuctionStatus,
   getKeyLaunchAuctionBids,
   invalidateKeyLaunchAuctionCache,
   KeyNotFoundError,
} from './key-launch-auction.service';
import { cacheSetJson } from '../../utils/redis.utils';
import {
   KEY_LAUNCH_AUCTION_ACTIVE_CACHE_TTL_SECONDS,
   KEY_LAUNCH_AUCTION_SETTLED_CACHE_TTL_SECONDS,
} from '../../constants/notifications.constants';

describe('key-launch-auction.service', () => {
   beforeEach(() => {
      redisStore.clear();
      jest.clearAllMocks();
   });

   describe('getKeyLaunchAuctionStatus', () => {
      it('throws KeyNotFoundError if key does not exist', async () => {
         (prisma.creatorProfile.findFirst as jest.Mock).mockResolvedValue(null);

         await expect(getKeyLaunchAuctionStatus('missing-key')).rejects.toBeInstanceOf(KeyNotFoundError);
      });

      it('returns not_configured status with countdown 0 when no auction exists', async () => {
         (prisma.creatorProfile.findFirst as jest.Mock).mockResolvedValue({ id: 'key-1' });
         (prisma as any).keyAuction.findUnique.mockResolvedValue(null);

         const result = await getKeyLaunchAuctionStatus('key-1');
         expect(result).toEqual({
            status: 'not_configured',
            highest_bid: null,
            reserve: null,
            countdown: 0,
            clearing_price: null,
         });
      });

      it('returns active status, countdown, and caches with 10s TTL during active auction', async () => {
         (prisma.creatorProfile.findFirst as jest.Mock).mockResolvedValue({ id: 'key-1' });
         const endTime = new Date(Date.now() + 60000); // 60s from now
         (prisma as any).keyAuction.findUnique.mockResolvedValue({
            id: 'auc-1',
            keyId: 'key-1',
            status: 'ACTIVE',
            reservePrice: '50.0000000',
            highestBid: '120.0000000',
            endTime,
            clearingPrice: null,
         });

         const result = await getKeyLaunchAuctionStatus('key-1');
         expect(result.status).toBe('active');
         expect(result.highest_bid).toBe('120.0000000');
         expect(result.reserve).toBe('50.0000000');
         expect(result.countdown).toBeGreaterThan(0);
         expect(result.clearing_price).toBeNull();

         expect(cacheSetJson).toHaveBeenCalledWith(
            expect.stringContaining('key:launch_auction:key-1'),
            expect.any(Object),
            KEY_LAUNCH_AUCTION_ACTIVE_CACHE_TTL_SECONDS
         );
      });

      it('returns settled status, clearing price, countdown 0, and caches with 300s TTL after settlement', async () => {
         (prisma.creatorProfile.findFirst as jest.Mock).mockResolvedValue({ id: 'key-1' });
         (prisma as any).keyAuction.findUnique.mockResolvedValue({
            id: 'auc-1',
            keyId: 'key-1',
            status: 'SETTLED',
            reservePrice: '50.0000000',
            highestBid: '150.0000000',
            clearingPrice: '150.0000000',
            endTime: new Date(Date.now() - 3600000),
         });

         const result = await getKeyLaunchAuctionStatus('key-1');
         expect(result.status).toBe('settled');
         expect(result.clearing_price).toBe('150.0000000');
         expect(result.countdown).toBe(0);

         expect(cacheSetJson).toHaveBeenCalledWith(
            expect.stringContaining('key:launch_auction:key-1'),
            expect.any(Object),
            KEY_LAUNCH_AUCTION_SETTLED_CACHE_TTL_SECONDS
         );
      });

      it('serves from Redis cache on repeated calls', async () => {
         (prisma.creatorProfile.findFirst as jest.Mock).mockResolvedValue({ id: 'key-1' });
         (prisma as any).keyAuction.findUnique.mockResolvedValue({
            id: 'auc-1',
            keyId: 'key-1',
            status: 'ACTIVE',
            reservePrice: '50.0000000',
            highestBid: '100.0000000',
            endTime: new Date(Date.now() + 60000),
            clearingPrice: null,
         });

         await getKeyLaunchAuctionStatus('key-1');
         expect((prisma as any).keyAuction.findUnique).toHaveBeenCalledTimes(1);

         const cached = await getKeyLaunchAuctionStatus('key-1');
         expect(cached.highest_bid).toBe('100.0000000');
         expect((prisma as any).keyAuction.findUnique).toHaveBeenCalledTimes(1);
      });
   });

   describe('getKeyLaunchAuctionBids', () => {
      it('returns paginated sorted bids and applies active TTL (10s)', async () => {
         (prisma.creatorProfile.findFirst as jest.Mock).mockResolvedValue({ id: 'key-1' });
         (prisma as any).keyAuction.findUnique.mockResolvedValue({
            id: 'auc-1',
            keyId: 'key-1',
            status: 'ACTIVE',
         });

         const mockBids = [
            {
               id: 'bid-1',
               bidder: 'wallet-a',
               amount: '200.0000000',
               txHash: '0x1',
               blockNumber: BigInt(500),
               timestamp: new Date('2026-10-19T10:00:00Z'),
            },
            {
               id: 'bid-2',
               bidder: 'wallet-b',
               amount: '150.0000000',
               txHash: '0x2',
               blockNumber: BigInt(499),
               timestamp: new Date('2026-10-19T09:50:00Z'),
            },
         ];
         (prisma as any).keyAuctionBid.findMany.mockResolvedValue(mockBids);
         (prisma as any).keyAuctionBid.count.mockResolvedValue(2);

         const result = await getKeyLaunchAuctionBids('key-1', { page: 1, limit: 10 });
         expect(result.bids).toHaveLength(2);
         expect(result.bids[0].amount).toBe('200.0000000');
         expect(result.bids[0].bidder).toBe('wallet-a');
         expect(result.total).toBe(2);

         expect(cacheSetJson).toHaveBeenCalledWith(
            expect.stringContaining('key:launch_auction:bids:key-1:1:10'),
            expect.any(Object),
            KEY_LAUNCH_AUCTION_ACTIVE_CACHE_TTL_SECONDS
         );
      });

      it('applies settled TTL (300s) when auction is settled', async () => {
         (prisma.creatorProfile.findFirst as jest.Mock).mockResolvedValue({ id: 'key-1' });
         (prisma as any).keyAuction.findUnique.mockResolvedValue({
            id: 'auc-1',
            keyId: 'key-1',
            status: 'SETTLED',
         });
         (prisma as any).keyAuctionBid.findMany.mockResolvedValue([]);
         (prisma as any).keyAuctionBid.count.mockResolvedValue(0);

         const result = await getKeyLaunchAuctionBids('key-1');
         expect(result.bids).toHaveLength(0);

         expect(cacheSetJson).toHaveBeenCalledWith(
            expect.any(String),
            expect.any(Object),
            KEY_LAUNCH_AUCTION_SETTLED_CACHE_TTL_SECONDS
         );
      });
   });

   describe('invalidateKeyLaunchAuctionCache', () => {
      it('invalidates redis cache keys', async () => {
         await invalidateKeyLaunchAuctionCache('key-1');
      });
   });
});
