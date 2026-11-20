// src/modules/traders/trader-discount.service.test.ts
import {
   getTraderDiscount,
   getVolumeDiscountTiers,
   invalidateTraderDiscountCache,
   invalidateVolumeDiscountTiersCache,
} from './trader-discount.service';
import { prisma } from '../../utils/prisma.utils';
import * as redisUtils from '../../utils/redis.utils';
import * as tradingVolumeUtils from '../../utils/trading-volume.utils';
import {
   DEFAULT_DISCOUNT_TIERS,
   VOLUME_DISCOUNT_TIERS_REDIS_KEY,
   VOLUME_DISCOUNT_WALLET_CACHE_TTL_SECONDS,
   traderDiscountRedisKey,
} from '../../constants/volume-discount.constants';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      volumeDiscountTier: {
         findMany: jest.fn(),
      },
   },
}));

jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn(),
   cacheSetJson: jest.fn(),
   cacheInvalidate: jest.fn(),
}));

jest.mock('../../utils/trading-volume.utils', () => ({
   computeWallet30dVolume: jest.fn(),
}));

describe('TraderDiscountService', () => {
   const WALLET = 'GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2G6EXO2Z6K35GUR223746';

   beforeEach(() => {
      jest.clearAllMocks();
   });

   describe('getVolumeDiscountTiers', () => {
      it('returns cached tiers when present in Redis', async () => {
         const cachedTiers = [
            { tier: 2, name: 'Tier 2', volumeThreshold: '5000000000000', discountBps: 200 },
            { tier: 1, name: 'Tier 1', volumeThreshold: '1000000000000', discountBps: 100 },
            { tier: 0, name: 'Tier 0', volumeThreshold: '0', discountBps: 0 },
         ];
         (redisUtils.cacheGetJson as jest.Mock).mockResolvedValue(cachedTiers);

         const result = await getVolumeDiscountTiers();

         expect(result).toEqual(cachedTiers);
         expect(prisma.volumeDiscountTier.findMany).not.toHaveBeenCalled();
      });

      it('fetches from DB and caches with 5-minute TTL on cache miss', async () => {
         (redisUtils.cacheGetJson as jest.Mock).mockResolvedValue(null);
         const dbTiers = [
            { tier: 2, name: 'VIP Gold', volumeThreshold: '5000000000000', discountBps: 200 },
            { tier: 1, name: 'VIP Silver', volumeThreshold: '1000000000000', discountBps: 100 },
            { tier: 0, name: 'Base', volumeThreshold: '0', discountBps: 0 },
         ];
         (prisma.volumeDiscountTier.findMany as jest.Mock).mockResolvedValue(dbTiers);

         const result = await getVolumeDiscountTiers();

         expect(result).toHaveLength(3);
         expect(result[0].name).toBe('VIP Gold');
         expect(redisUtils.cacheSetJson).toHaveBeenCalledWith(
            VOLUME_DISCOUNT_TIERS_REDIS_KEY,
            expect.any(Array),
            300
         );
      });

      it('falls back to DEFAULT_DISCOUNT_TIERS when DB has no tiers', async () => {
         (redisUtils.cacheGetJson as jest.Mock).mockResolvedValue(null);
         (prisma.volumeDiscountTier.findMany as jest.Mock).mockResolvedValue([]);

         const result = await getVolumeDiscountTiers();

         expect(result).toHaveLength(DEFAULT_DISCOUNT_TIERS.length);
         expect(result.some(t => t.tier === 0 && t.discountBps === 0)).toBe(true);
      });
   });

   describe('getTraderDiscount', () => {
      it('returns cached trader discount when present in Redis', async () => {
         const cached = {
            wallet: WALLET,
            tier: 1,
            tierLabel: 'TIER_1',
            discountBps: 100,
            volume30d: '1500000000000',
            volume30dStroops: '1500000000000',
         };
         (redisUtils.cacheGetJson as jest.Mock).mockImplementation((key: string) => {
            if (key === traderDiscountRedisKey(WALLET)) return Promise.resolve(cached);
            return Promise.resolve(null);
         });

         const result = await getTraderDiscount(WALLET);

         expect(result).toEqual(cached);
         expect(tradingVolumeUtils.computeWallet30dVolume).not.toHaveBeenCalled();
      });

      it('computes rolling 30d volume and returns Tier 0 (0 discount) for 0-volume wallet', async () => {
         (redisUtils.cacheGetJson as jest.Mock).mockResolvedValue(null);
         (tradingVolumeUtils.computeWallet30dVolume as jest.Mock).mockResolvedValue(0n);
         (prisma.volumeDiscountTier.findMany as jest.Mock).mockResolvedValue([]);

         const result = await getTraderDiscount(WALLET);

         expect(result).toEqual({
            wallet: WALLET,
            tier: 0,
            tierLabel: 'TIER_0',
            discountBps: 0,
            volume30d: '0',
            volume30dStroops: '0',
         });
         expect(redisUtils.cacheSetJson).toHaveBeenCalledWith(
            traderDiscountRedisKey(WALLET),
            result,
            VOLUME_DISCOUNT_WALLET_CACHE_TTL_SECONDS
         );
      });

      it('computes rolling 30d volume and selects Tier 1 (100 bps) for 100,000+ XLM volume', async () => {
         (redisUtils.cacheGetJson as jest.Mock).mockResolvedValue(null);
         // 1,500,000,000,000 stroops = 150,000 XLM
         (tradingVolumeUtils.computeWallet30dVolume as jest.Mock).mockResolvedValue(1500000000000n);
         (prisma.volumeDiscountTier.findMany as jest.Mock).mockResolvedValue([]);

         const result = await getTraderDiscount(WALLET);

         expect(result.tier).toBe(1);
         expect(result.discountBps).toBe(100);
         expect(result.volume30d).toBe('1500000000000');
         expect(redisUtils.cacheSetJson).toHaveBeenCalledWith(
            traderDiscountRedisKey(WALLET),
            result,
            300
         );
      });

      it('computes rolling 30d volume and selects Tier 2 (200 bps) for 500,000+ XLM volume', async () => {
         (redisUtils.cacheGetJson as jest.Mock).mockResolvedValue(null);
         // 6,000,000,000,000 stroops = 600,000 XLM
         (tradingVolumeUtils.computeWallet30dVolume as jest.Mock).mockResolvedValue(6000000000000n);
         (prisma.volumeDiscountTier.findMany as jest.Mock).mockResolvedValue([]);

         const result = await getTraderDiscount(WALLET);

         expect(result.tier).toBe(2);
         expect(result.discountBps).toBe(200);
         expect(result.volume30d).toBe('6000000000000');
         expect(redisUtils.cacheSetJson).toHaveBeenCalledWith(
            traderDiscountRedisKey(WALLET),
            result,
            300
         );
      });
   });

   describe('cache invalidation', () => {
      it('invalidates specific wallet cache', async () => {
         await invalidateTraderDiscountCache(WALLET);

         expect(redisUtils.cacheInvalidate).toHaveBeenCalledWith(
            traderDiscountRedisKey(WALLET)
         );
      });

      it('invalidates global tiers cache and all wallet discount entries', async () => {
         await invalidateVolumeDiscountTiersCache();

         expect(redisUtils.cacheInvalidate).toHaveBeenCalledWith(
            VOLUME_DISCOUNT_TIERS_REDIS_KEY,
            'traders:discount:*'
         );
      });
   });
});
