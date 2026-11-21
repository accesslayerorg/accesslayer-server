// src/modules/keys/key-dynamic-fee.service.test.ts
import { getDynamicFeeRate } from './key-dynamic-fee.service';
import { prisma } from '../../utils/prisma.utils';
import * as redisUtils from '../../utils/redis.utils';
import * as traderDiscountService from '../traders/trader-discount.service';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      creatorProfile: {
         findFirst: jest.fn(),
      },
      protocolConfig: {
         findFirst: jest.fn(),
      },
   },
}));

jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn(),
   cacheSetJson: jest.fn(),
}));

jest.mock('../traders/trader-discount.service', () => ({
   getTraderDiscount: jest.fn(),
}));

describe('KeyDynamicFeeService', () => {
   const CREATOR_ID = 'creator-uuid-1';
   const WALLET = 'GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2G6EXO2Z6K35GUR223746';

   beforeEach(() => {
      jest.clearAllMocks();
      (redisUtils.cacheGetJson as jest.Mock).mockResolvedValue(null);
      (prisma.protocolConfig.findFirst as jest.Mock).mockResolvedValue({
         protocolFeeBps: 500,
      });
      (prisma.creatorProfile.findFirst as jest.Mock).mockResolvedValue({
         id: CREATOR_ID,
         circulatingSupply: 100,
         creatorRoyaltyBuyBps: 200,
         creatorRoyaltySellBps: 200,
      });
   });

   it('includes discount tier and bps in fee breakdown when wallet is provided', async () => {
      (traderDiscountService.getTraderDiscount as jest.Mock).mockResolvedValue({
         wallet: WALLET,
         tier: 1,
         tierLabel: 'TIER_1',
         discountBps: 100,
         volume30d: '1500000000000',
         volume30dStroops: '1500000000000',
      });

      const result = await getDynamicFeeRate(CREATOR_ID, 1, 'buy', WALLET);

      expect(traderDiscountService.getTraderDiscount).toHaveBeenCalledWith(WALLET);

      // Breakdown components check
      expect(result.components).toEqual({
         baseBps: 500,
         volumeTierDiscountBps: 100,
         protocolBps: 400, // 500 - 100
         royaltyBps: 200,
         discountTier: 1,
         tier: 1,
         tierLabel: 'TIER_1',
      });

      // Top-level tier check
      expect(result.discountTier).toBe(1);
      expect(result.tier).toBe(1);

      // Effective rate: 400 + 200 = 600 bps = 0.06
      expect(result.effectiveRate).toBe(0.06);
   });

   it('reflects higher discount tier for high-volume wallets', async () => {
      (traderDiscountService.getTraderDiscount as jest.Mock).mockResolvedValue({
         wallet: WALLET,
         tier: 2,
         tierLabel: 'TIER_2',
         discountBps: 200,
         volume30d: '5500000000000',
         volume30dStroops: '5500000000000',
      });

      const result = await getDynamicFeeRate(CREATOR_ID, 5, 'buy', WALLET);

      expect(result.components.volumeTierDiscountBps).toBe(200);
      expect(result.components.protocolBps).toBe(300); // 500 - 200
      expect(result.components.discountTier).toBe(2);
      expect(result.discountTier).toBe(2);

      // Effective rate: 300 + 200 = 500 bps = 0.05
      expect(result.effectiveRate).toBe(0.05);
   });

   it('uses base fee with zero discount when wallet is omitted', async () => {
      const result = await getDynamicFeeRate(CREATOR_ID, 1, 'buy');

      expect(traderDiscountService.getTraderDiscount).not.toHaveBeenCalled();
      expect(result.components).toEqual({
         baseBps: 500,
         volumeTierDiscountBps: 0,
         protocolBps: 500,
         royaltyBps: 200,
         discountTier: 0,
         tier: 0,
         tierLabel: 'TIER_0',
      });
      expect(result.discountTier).toBe(0);
      expect(result.tier).toBe(0);
      expect(result.effectiveRate).toBe(0.07); // (500 + 200) / 10000
   });
});
