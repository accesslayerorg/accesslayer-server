// src/modules/staking/staking.service.test.ts
import {
   calculateEffectiveWeight,
   DEFAULT_CONTRACT_MULTIPLIER_TIERS,
   getMultiplierTiers,
   getPositionEffectiveWeight,
   getStakingPositionById,
   getStakingPositions,
   invalidateStakingTiersCache,
   matchTierForLockPeriod,
   STAKING_TIERS_CACHE_KEY,
   STAKING_TIERS_CACHE_TTL_SECONDS,
   StakingPositionNotFoundError,
} from './staking.service';
import { prisma } from '../../utils/prisma.utils';
import * as redisUtils from '../../utils/redis.utils';

jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn(),
   cacheSetJson: jest.fn(),
   cacheInvalidate: jest.fn(),
}));

describe('Staking Service', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   describe('calculateEffectiveWeight', () => {
      it('calculates weighted stake accurately for integers', () => {
         expect(calculateEffectiveWeight(100, 1.25)).toBe('125');
         expect(calculateEffectiveWeight('1000', '1.5')).toBe('1500');
         expect(calculateEffectiveWeight(50, 2.0)).toBe('100');
         expect(calculateEffectiveWeight(10, 2.5)).toBe('25');
      });

      it('calculates weighted stake accurately for decimal amounts', () => {
         expect(calculateEffectiveWeight(100.5, 1.25)).toBe('125.625');
         expect(calculateEffectiveWeight('50.25', '1.5')).toBe('75.375');
      });

      it('returns 0 for zero or invalid inputs', () => {
         expect(calculateEffectiveWeight(0, 1.5)).toBe('0');
         expect(calculateEffectiveWeight('invalid', 1.5)).toBe('0');
         expect(calculateEffectiveWeight(100, -1)).toBe('0');
      });
   });

   describe('matchTierForLockPeriod', () => {
      it('matches correct tier based on lock period thresholds', () => {
         const tiers = DEFAULT_CONTRACT_MULTIPLIER_TIERS;

         // 0s lock -> Tier 0 (1.0x)
         expect(matchTierForLockPeriod(0, tiers).tier).toBe(0);
         expect(matchTierForLockPeriod(1000, tiers).tier).toBe(0);

         // 30 days -> Tier 1 (1.25x)
         expect(matchTierForLockPeriod(30 * 86400, tiers).tier).toBe(1);
         expect(matchTierForLockPeriod(60 * 86400, tiers).tier).toBe(1);

         // 90 days -> Tier 2 (1.5x)
         expect(matchTierForLockPeriod(90 * 86400, tiers).tier).toBe(2);

         // 180 days -> Tier 3 (2.0x)
         expect(matchTierForLockPeriod(180 * 86400, tiers).tier).toBe(3);

         // 365 days -> Tier 4 (2.5x)
         expect(matchTierForLockPeriod(365 * 86400, tiers).tier).toBe(4);
         expect(matchTierForLockPeriod(400 * 86400, tiers).tier).toBe(4);
      });
   });

   describe('getMultiplierTiers & Caching', () => {
      it('returns cached tiers from Redis when available (cache hit)', async () => {
         const cachedTiers = [
            {
               tier: 0,
               name: 'Cached Tier 0',
               lockPeriod: 0,
               lockPeriodSeconds: 0,
               lockPeriodDays: 0,
               multiplier: 1.0,
               multiplierFormatted: '1x',
            },
         ];
         (redisUtils.cacheGetJson as jest.Mock).mockResolvedValueOnce(
            cachedTiers
         );

         const result = await getMultiplierTiers();
         expect(result).toEqual(cachedTiers);
         expect(redisUtils.cacheGetJson).toHaveBeenCalledWith(
            STAKING_TIERS_CACHE_KEY
         );
         expect(redisUtils.cacheSetJson).not.toHaveBeenCalled();
      });

      it('fetches from DB and populates 5-minute Redis cache on cache miss', async () => {
         (redisUtils.cacheGetJson as jest.Mock).mockResolvedValueOnce(null);
         const dbTiers = [
            {
               id: 'tier-0',
               tier: 0,
               name: 'Flexible',
               lockPeriodSeconds: 0,
               multiplier: 1.0,
            },
            {
               id: 'tier-1',
               tier: 1,
               name: '30 Days',
               lockPeriodSeconds: 2592000,
               multiplier: 1.25,
            },
         ];

         (prisma as any).stakingMultiplierTier = {
            findMany: jest.fn().mockResolvedValueOnce(dbTiers),
         };

         const result = await getMultiplierTiers();
         expect(result).toHaveLength(2);
         expect(result[0].multiplier).toBe(1.0);
         expect(result[1].multiplier).toBe(1.25);
         expect(result[1].lockPeriodSeconds).toBe(2592000);

         expect(redisUtils.cacheSetJson).toHaveBeenCalledWith(
            STAKING_TIERS_CACHE_KEY,
            expect.any(Array),
            STAKING_TIERS_CACHE_TTL_SECONDS
         );
         expect(STAKING_TIERS_CACHE_TTL_SECONDS).toBe(300); // 5 minutes TTL
      });

      it('falls back to default contract tiers if DB returns empty', async () => {
         (redisUtils.cacheGetJson as jest.Mock).mockResolvedValueOnce(null);
         (prisma as any).stakingMultiplierTier = {
            findMany: jest.fn().mockResolvedValueOnce([]),
            upsert: jest.fn().mockResolvedValue({}),
         };

         const result = await getMultiplierTiers();
         expect(result.length).toBeGreaterThanOrEqual(5);
         expect(result[0].tier).toBe(0);
         expect(result[0].multiplier).toBe(1.0);
         expect(redisUtils.cacheSetJson).toHaveBeenCalledWith(
            STAKING_TIERS_CACHE_KEY,
            DEFAULT_CONTRACT_MULTIPLIER_TIERS,
            300
         );
      });
   });

   describe('invalidateStakingTiersCache', () => {
      it('calls cacheInvalidate with STAKING_TIERS_CACHE_KEY', async () => {
         await invalidateStakingTiersCache();
         expect(redisUtils.cacheInvalidate).toHaveBeenCalledWith(
            STAKING_TIERS_CACHE_KEY
         );
      });
   });

   describe('getStakingPositionById & getPositionEffectiveWeight', () => {
      beforeEach(() => {
         (redisUtils.cacheGetJson as jest.Mock).mockResolvedValue(
            DEFAULT_CONTRACT_MULTIPLIER_TIERS
         );
      });

      it('returns StakingPosition with embedded tier data and correct effective weight', async () => {
         const mockPosition = {
            id: 'pos-123',
            wallet: 'GBTESTWALLET123',
            keyId: 'creator-key-1',
            amount: 1000,
            lockPeriodSeconds: 90 * 86400, // 90 days -> Tier 2 (1.5x)
            lockedAt: new Date('2026-09-01T00:00:00Z'),
            unlocksAt: new Date('2026-12-01T00:00:00Z'),
            tier: 2,
            createdAt: new Date('2026-09-01T00:00:00Z'),
            updatedAt: new Date('2026-09-01T00:00:00Z'),
         };

         (prisma as any).stakingPosition = {
            findUnique: jest.fn().mockResolvedValue(mockPosition),
         };

         const position = await getStakingPositionById('pos-123');
         expect(position.id).toBe('pos-123');
         expect(position.wallet).toBe('GBTESTWALLET123');
         expect(position.tier).toBe(2);
         expect(position.tierData.multiplier).toBe(1.5);
         expect(position.effectiveWeight).toBe('1500'); // 1000 * 1.5

         const weightRes = await getPositionEffectiveWeight('pos-123');
         expect(weightRes.positionId).toBe('pos-123');
         expect(weightRes.effectiveWeight).toBe('1500');
         expect(weightRes.multiplier).toBe(1.5);
         expect(weightRes.tier.tier).toBe(2);
      });

      it('falls back to KeyOwnership if StakingPosition row is not found', async () => {
         (prisma as any).stakingPosition = {
            findUnique: jest.fn().mockResolvedValueOnce(null),
         };

         const mockOwnership = {
            id: 'ownership-456',
            ownerAddress: 'GBSTAKER999',
            creatorId: 'creator-xyz',
            balance: 200,
            costBasis: '10',
            lastBuyAt: new Date('2026-08-01T00:00:00Z'),
            lockupExpiresAt: new Date('2026-08-31T00:00:00Z'), // ~30 days -> Tier 1 (1.25x)
            frozen: false,
            frozenAt: null,
            createdAt: new Date('2026-08-01T00:00:00Z'),
            updatedAt: new Date('2026-08-01T00:00:00Z'),
         };

         (prisma as any).keyOwnership = {
            findUnique: jest.fn().mockResolvedValueOnce(mockOwnership),
         };

         const position = await getStakingPositionById('ownership-456');
         expect(position.id).toBe('ownership-456');
         expect(position.wallet).toBe('GBSTAKER999');
         expect(position.tier).toBe(1);
         expect(position.tierData.multiplier).toBe(1.25);
         expect(position.effectiveWeight).toBe('250'); // 200 * 1.25
      });

      it('throws StakingPositionNotFoundError when not found in either table', async () => {
         (prisma as any).stakingPosition = {
            findUnique: jest.fn().mockResolvedValueOnce(null),
         };
         (prisma as any).keyOwnership = {
            findUnique: jest.fn().mockResolvedValueOnce(null),
         };

         await expect(getStakingPositionById('non-existent')).rejects.toThrow(
            StakingPositionNotFoundError
         );
      });
   });

   describe('getStakingPositions', () => {
      beforeEach(() => {
         (redisUtils.cacheGetJson as jest.Mock).mockResolvedValue(
            DEFAULT_CONTRACT_MULTIPLIER_TIERS
         );
      });

      it('returns list of staking positions with embedded tier data', async () => {
         const mockPositions = [
            {
               id: 'pos-1',
               wallet: 'GBTEST1',
               keyId: 'creator-1',
               amount: 500,
               lockPeriodSeconds: 0,
               tier: 0,
               lockedAt: new Date(),
               unlocksAt: null,
               createdAt: new Date(),
               updatedAt: new Date(),
            },
         ];

         (prisma as any).stakingPosition = {
            findMany: jest.fn().mockResolvedValueOnce(mockPositions),
         };

         const list = await getStakingPositions({ wallet: 'GBTEST1' });
         expect(list).toHaveLength(1);
         expect(list[0].id).toBe('pos-1');
         expect(list[0].effectiveWeight).toBe('500'); // 500 * 1.0
         expect(list[0].tierData).toBeDefined();
      });
   });
});
