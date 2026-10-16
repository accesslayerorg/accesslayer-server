import {
   getTraderDiscount,
   indexVolumeDiscountTierChangedEvent,
   resetTraderDiscountStateForTests,
   TRADER_DISCOUNT_CACHE_TTL_SECONDS,
} from './trader-discount.service';

const mockCache = new Map<string, { value: any; ttl: number }>();

jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn(async (key: string) =>
      mockCache.has(key) ? mockCache.get(key)!.value : null
   ),
   cacheSetJson: jest.fn(async (key: string, value: any, ttl: number) => {
      mockCache.set(key, { value, ttl });
   }),
   cacheInvalidate: jest.fn(async (key: string) => {
      mockCache.delete(key);
   }),
}));

const mockComputeWallet30dVolume = jest.fn<Promise<bigint>, [string]>();
jest.mock('../../utils/trading-volume.utils', () => ({
   computeWallet30dVolume: (wallet: string) =>
      mockComputeWallet30dVolume(wallet),
}));

jest.mock('../protocol/fee-tier.service', () => ({
   loadFeeTierConfig: jest.fn(async () => [
      { volumeThreshold: 0, feeBps: 500, label: 'TIER_1' },
      { volumeThreshold: 1_000_000_000_000, feeBps: 400, label: 'TIER_2' },
      { volumeThreshold: 5_000_000_000_000, feeBps: 300, label: 'TIER_3' },
   ]),
}));

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
   },
}));

const WALLET = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

describe('fee discount tier indexing & lookup (#1030)', () => {
   beforeEach(() => {
      mockCache.clear();
      resetTraderDiscountStateForTests();
      jest.clearAllMocks();
   });

   it('computes 30d rolling volume discount tier and caches with 5-minute TTL', async () => {
      mockComputeWallet30dVolume.mockResolvedValue(2_500_000_000_000n);

      const first = await getTraderDiscount(WALLET);
      expect(first).toEqual({
         wallet: WALLET,
         tier: 'TIER_2',
         discountBps: 100,
         volume30dStroops: '2500000000000',
         cached: false,
      });

      const cachedEntry = mockCache.get(`trader:discount:${WALLET}`);
      expect(cachedEntry?.ttl).toBe(TRADER_DISCOUNT_CACHE_TTL_SECONDS);

      const second = await getTraderDiscount(WALLET);
      expect(second.cached).toBe(true);
      expect(mockComputeWallet30dVolume).toHaveBeenCalledTimes(1);
   });

   it('indexes VolumeDiscountTierChanged events without duplication and refreshes cache', async () => {
      mockComputeWallet30dVolume.mockResolvedValue(0n);

      await getTraderDiscount(WALLET);
      expect(mockCache.has(`trader:discount:${WALLET}`)).toBe(true);

      const evt = {
         txHash: 'tx_abc',
         ledger: 12345,
         eventIndex: 0,
         wallet: WALLET,
         tier: 'TIER_3',
         discountBps: 200,
      };

      const res1 = await indexVolumeDiscountTierChangedEvent(evt);
      expect(res1).toEqual({ indexed: true, duplicate: false });
      expect(mockCache.has(`trader:discount:${WALLET}`)).toBe(false);

      const res2 = await indexVolumeDiscountTierChangedEvent(evt);
      expect(res2).toEqual({ indexed: false, duplicate: true });

      const updated = await getTraderDiscount(WALLET);
      expect(updated.tier).toBe('TIER_3');
      expect(updated.discountBps).toBe(200);
   });
});
