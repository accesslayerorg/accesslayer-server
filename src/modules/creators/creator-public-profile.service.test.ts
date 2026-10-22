// src/modules/creators/creator-public-profile.service.test.ts
// Unit tests for public creator profile service (#1009).

const mockPrisma = {
   stellarWallet: {
      findUnique: jest.fn(),
   },
   creatorProfile: {
      findMany: jest.fn(),
   },
   kycRecord: {
      findUnique: jest.fn(),
   },
   keyOwnership: {
      count: jest.fn(),
   },
   trade: {
      findMany: jest.fn(),
   },
   creatorReputation: {
      findMany: jest.fn(),
   },
   creatorPriceSnapshot: {
      findUnique: jest.fn(),
   },
};

const mockCache = {
   cacheGetJson: jest.fn(),
   cacheSetJson: jest.fn(),
   cacheInvalidate: jest.fn(),
};

jest.mock('../../utils/prisma.utils', () => ({ prisma: mockPrisma }));
jest.mock('../../utils/redis.utils', () => mockCache);

import {
   getCreatorPublicProfile,
   getCreatorDeployedKeys,
} from './creator-public-profile.service';

describe('Creator Public Profile Service (#1009)', () => {
   const wallet = 'G' + 'A'.repeat(55);
   const unregisteredWallet = 'G' + 'B'.repeat(55);
   const date1 = new Date('2026-01-01T00:00:00.000Z');
   const date2 = new Date('2026-02-01T00:00:00.000Z');

   beforeEach(() => {
      jest.clearAllMocks();
   });

   describe('getCreatorPublicProfile', () => {
      it('returns 404 (null) for unregistered wallet addresses', async () => {
         mockCache.cacheGetJson.mockResolvedValue(null);
         mockPrisma.stellarWallet.findUnique.mockResolvedValue(null);
         mockPrisma.creatorProfile.findMany.mockResolvedValue([]);
         mockPrisma.kycRecord.findUnique.mockResolvedValue(null);

         const result = await getCreatorPublicProfile(unregisteredWallet);
         expect(result).toBeNull();
      });

      it('serves cached profile when available in Redis cache', async () => {
         const cachedData = {
            wallet,
            memberSince: date1.toISOString(),
            totalKeys: 1,
            totalVolume: '1000',
            avgRating: 4.5,
            isVerified: true,
            handle: 'creator1',
            displayName: 'Creator One',
            bio: 'Bio',
            avatarUrl: null,
            stats: {
               totalHolders: 5,
               totalTradingVolume: '1000',
               followersCount: 10,
            },
         };
         mockCache.cacheGetJson.mockResolvedValue(cachedData);

         const result = await getCreatorPublicProfile(wallet);
         expect(result).toEqual(cachedData);
         expect(mockPrisma.stellarWallet.findUnique).not.toHaveBeenCalled();
      });

      it('aggregates stats correctly across all creator keys and caches for 5 minutes', async () => {
         mockCache.cacheGetJson.mockResolvedValue(null);
         mockPrisma.stellarWallet.findUnique.mockResolvedValue({
            createdAt: date1,
            userId: 'user-1',
         });
         mockPrisma.creatorProfile.findMany.mockResolvedValue([
            {
               id: 'key-1',
               userId: 'user-1',
               handle: 'first_key',
               displayName: 'First Key',
               bio: 'Bio 1',
               avatarUrl: 'https://example.com/1.png',
               isVerified: false,
               tradingPaused: false,
               deprecatedAt: null,
               followersCount: 10,
               createdAt: date1,
            },
            {
               id: 'key-2',
               userId: 'user-1',
               handle: 'second_key',
               displayName: 'Second Key',
               bio: 'Bio 2',
               avatarUrl: 'https://example.com/2.png',
               isVerified: false,
               tradingPaused: false,
               deprecatedAt: null,
               followersCount: 15,
               createdAt: date2,
            },
         ]);
         mockPrisma.kycRecord.findUnique.mockResolvedValue(null);
         mockPrisma.keyOwnership.count.mockResolvedValue(8);
         mockPrisma.trade.findMany.mockResolvedValue([
            { price: '100', quantity: '5' },
            { price: '200', quantity: '2' },
         ]);
         mockPrisma.creatorReputation.findMany.mockResolvedValue([
            { currentScore: 800 },
            { currentScore: 900 },
         ]);

         const result = await getCreatorPublicProfile(wallet);

         expect(result).not.toBeNull();
         expect(result?.wallet).toBe(wallet);
         expect(result?.memberSince).toBe(date1.toISOString());
         expect(result?.totalKeys).toBe(2);
         // Total volume = (100 * 5) + (200 * 2) = 500 + 400 = 900
         expect(result?.totalVolume).toBe('900');
         // Avg score = (800 + 900) / 2 = 850. 850 / 200 = 4.25 -> 4.3 or 4.2
         expect(result?.avgRating).toBe(4.3);
         expect(result?.isVerified).toBe(false);
         expect(result?.stats).toEqual({
            totalHolders: 8,
            totalTradingVolume: '900',
            followersCount: 25,
         });

         // Verify cache set with 5-minute TTL (300 seconds)
         expect(mockCache.cacheSetJson).toHaveBeenCalledWith(
            `creator-public-profile:v1:${wallet}`,
            expect.objectContaining({ wallet, totalKeys: 2, totalVolume: '900' }),
            300
         );
      });

      it('derives verified badge flag correctly from KYC status', async () => {
         mockCache.cacheGetJson.mockResolvedValue(null);
         mockPrisma.stellarWallet.findUnique.mockResolvedValue({
            createdAt: date1,
            userId: 'user-1',
         });
         mockPrisma.creatorProfile.findMany.mockResolvedValue([
            {
               id: 'key-1',
               userId: 'user-1',
               handle: 'verified_creator',
               displayName: 'Verified Creator',
               bio: null,
               avatarUrl: null,
               isVerified: false,
               tradingPaused: false,
               deprecatedAt: null,
               followersCount: 0,
               createdAt: date1,
            },
         ]);
         mockPrisma.kycRecord.findUnique.mockResolvedValue({
            status: 'APPROVED',
         });
         mockPrisma.keyOwnership.count.mockResolvedValue(0);
         mockPrisma.trade.findMany.mockResolvedValue([]);
         mockPrisma.creatorReputation.findMany.mockResolvedValue([]);

         const result = await getCreatorPublicProfile(wallet);
         expect(result?.isVerified).toBe(true);
      });
   });

   describe('getCreatorDeployedKeys', () => {
      it('returns 404 (null) for unregistered wallet addresses', async () => {
         mockPrisma.stellarWallet.findUnique.mockResolvedValue(null);
         mockPrisma.creatorProfile.findMany.mockResolvedValue([]);
         mockPrisma.kycRecord.findUnique.mockResolvedValue(null);

         const result = await getCreatorDeployedKeys(unregisteredWallet);
         expect(result).toBeNull();
      });

      it('returns deployed keys in deployment order with status and price', async () => {
         mockPrisma.stellarWallet.findUnique.mockResolvedValue({
            createdAt: date1,
            userId: 'user-1',
         });
         // The service queries profiles with orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
         mockPrisma.creatorProfile.findMany
            // First call in resolveWalletProfiles
            .mockResolvedValueOnce([
               { id: 'key-1', userId: 'user-1', createdAt: date1 },
               { id: 'key-2', userId: 'user-1', createdAt: date2 },
            ])
            // Second call in getCreatorDeployedKeys (page query)
            .mockResolvedValueOnce([
               {
                  id: 'key-1',
                  handle: 'key1',
                  displayName: 'Key 1',
                  bio: 'Bio 1',
                  avatarUrl: null,
                  isVerified: true,
                  tradingPaused: false,
                  deprecatedAt: null,
                  createdAt: date1,
               },
               {
                  id: 'key-2',
                  handle: 'key2',
                  displayName: 'Key 2',
                  bio: 'Bio 2',
                  avatarUrl: null,
                  isVerified: false,
                  tradingPaused: true,
                  deprecatedAt: null,
                  createdAt: date2,
               },
            ])
            // Third call in getCreatorDeployedKeys (allIds query)
            .mockResolvedValueOnce([
               { id: 'key-1' },
               { id: 'key-2' },
            ]);

         mockPrisma.kycRecord.findUnique.mockResolvedValue({ status: 'APPROVED' });

         // Mock keyOwnership, trade, and priceSnapshot for each key
         mockPrisma.keyOwnership.count
            .mockResolvedValueOnce(3) // key-1 holder count
            .mockResolvedValueOnce(2) // key-2 holder count
            .mockResolvedValueOnce(5); // total holders across all keys

         mockPrisma.trade.findMany
            .mockResolvedValueOnce([{ price: '50', quantity: '2' }]) // key-1 trades
            .mockResolvedValueOnce([]) // key-2 trades
            .mockResolvedValueOnce([{ price: '50', quantity: '2' }]); // all trades

         mockPrisma.creatorPriceSnapshot.findUnique
            .mockResolvedValueOnce({ currentPrice: 1500000n }) // key-1 price
            .mockResolvedValueOnce(null); // key-2 price

         const page = await getCreatorDeployedKeys(wallet, '10');

         expect(page).not.toBeNull();
         expect(page?.items).toHaveLength(2);
         expect(page?.items[0]).toEqual({
            id: 'key-1',
            handle: 'key1',
            displayName: 'Key 1',
            bio: 'Bio 1',
            avatarUrl: null,
            isVerified: true,
            holderCount: 3,
            totalTradingVolume: '100',
            status: 'ACTIVE',
            price: '1500000',
            createdAt: date1.toISOString(),
         });
         expect(page?.items[1]).toEqual({
            id: 'key-2',
            handle: 'key2',
            displayName: 'Key 2',
            bio: 'Bio 2',
            avatarUrl: null,
            isVerified: false,
            holderCount: 2,
            totalTradingVolume: '0',
            status: 'PAUSED',
            price: '0',
            createdAt: date2.toISOString(),
         });
         expect(page?.stats).toEqual({
            totalKeys: 2,
            totalHolders: 5,
            totalTradingVolume: '100',
         });
      });

      it('validates pagination limit parameter', async () => {
         mockPrisma.stellarWallet.findUnique.mockResolvedValue({
            createdAt: date1,
            userId: 'user-1',
         });
         mockPrisma.creatorProfile.findMany.mockResolvedValue([
            { id: 'key-1', userId: 'user-1', createdAt: date1 },
         ]);

         await expect(getCreatorDeployedKeys(wallet, 'invalid')).rejects.toThrow(
            'Invalid keys pagination limit'
         );
         await expect(getCreatorDeployedKeys(wallet, '0')).rejects.toThrow(
            'Invalid keys pagination limit'
         );
         await expect(getCreatorDeployedKeys(wallet, '101')).rejects.toThrow(
            'Invalid keys pagination limit'
         );
      });
   });
});
