// src/modules/keys/__tests__/key-reserve.service.test.ts
import { Decimal } from '@prisma/client/runtime/library';

let cacheStore = new Map<string, any>();

jest.mock('../../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn(async (key: string) => cacheStore.get(key) ?? null),
   cacheSetJson: jest.fn(async (key: string, val: any) => {
      cacheStore.set(key, val);
   }),
   cacheInvalidate: jest.fn(async (key: string) => {
      cacheStore.delete(key);
   }),
}));

const prismaMock = {
   creatorProfile: {
      findUnique: jest.fn(),
   },
   keyReserve: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
   },
   creatorPriceSnapshot: {
      findUnique: jest.fn(),
   },
};

jest.mock('../../../utils/prisma.utils', () => ({
   prisma: prismaMock,
}));

import {
   getKeyReserve,
   invalidateKeyReserveCache,
   KeyNotFoundError,
} from '../key-reserve.service';

describe('key-reserve.service', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      cacheStore.clear();
   });

   it('throws KeyNotFoundError if key does not exist', async () => {
      prismaMock.creatorProfile.findUnique.mockResolvedValueOnce(null);

      await expect(getKeyReserve('unknown-key')).rejects.toThrow(KeyNotFoundError);
   });

   it('returns zero reserve and false low_reserve when no reserve accrued', async () => {
      prismaMock.creatorProfile.findUnique.mockResolvedValueOnce({
         id: 'key-1',
         circulatingSupply: new Decimal(100),
      });
      prismaMock.keyReserve.findUnique.mockResolvedValueOnce(null);
      prismaMock.creatorPriceSnapshot.findUnique.mockResolvedValueOnce({
         currentPrice: BigInt(50000000), // 5 XLM
      });

      const res = await getKeyReserve('key-1');

      expect(res.key_id).toBe('key-1');
      expect(res.reserve_balance).toBe('0');
      expect(res.market_cap).toBe('5000000000');
      expect(res.reserve_ratio_bps).toBe(0);
      expect(res.low_reserve).toBe(true); // ratio 0 < 1000 bps
   });

   it('correctly flags low_reserve when reserve ratio is below 10%', async () => {
      prismaMock.creatorProfile.findUnique.mockResolvedValueOnce({
         id: 'key-2',
         circulatingSupply: new Decimal(100),
      });
      // market cap = 100 * 1000 = 100,000
      prismaMock.creatorPriceSnapshot.findUnique.mockResolvedValueOnce({
         currentPrice: BigInt(1000),
      });
      // reserve = 5,000 -> ratio = 5,000 * 10,000 / 100,000 = 500 bps (5%) < 1000 bps
      prismaMock.keyReserve.findUnique.mockResolvedValueOnce({
         keyId: 'key-2',
         reserveBalance: new Decimal(5000),
      });

      const res = await getKeyReserve('key-2');

      expect(res.reserve_balance).toBe('5000');
      expect(res.market_cap).toBe('100000');
      expect(res.reserve_ratio_bps).toBe(500);
      expect(res.low_reserve).toBe(true);
   });

   it('flags low_reserve as false when reserve ratio is at or above 10%', async () => {
      prismaMock.creatorProfile.findUnique.mockResolvedValueOnce({
         id: 'key-3',
         circulatingSupply: new Decimal(100),
      });
      // market cap = 100 * 1000 = 100,000
      prismaMock.creatorPriceSnapshot.findUnique.mockResolvedValueOnce({
         currentPrice: BigInt(1000),
      });
      // reserve = 15,000 -> ratio = 15,000 * 10,000 / 100,000 = 1500 bps (15%) >= 1000 bps
      prismaMock.keyReserve.findUnique.mockResolvedValueOnce({
         keyId: 'key-3',
         reserveBalance: new Decimal(15000),
      });

      const res = await getKeyReserve('key-3');

      expect(res.reserve_balance).toBe('15000');
      expect(res.market_cap).toBe('100000');
      expect(res.reserve_ratio_bps).toBe(1500);
      expect(res.low_reserve).toBe(false);
   });

   it('returns cached result when available', async () => {
      const cachedData = {
         key_id: 'key-cached',
         reserve_balance: '8888',
         market_cap: '10000',
         reserve_ratio_bps: 8888,
         low_reserve: false,
      };
      cacheStore.set('key:reserve:key-cached', cachedData);

      const res = await getKeyReserve('key-cached');

      expect(res).toEqual(cachedData);
      expect(prismaMock.creatorProfile.findUnique).not.toHaveBeenCalled();
   });

   it('invalidates cache correctly', async () => {
      cacheStore.set('key:reserve:key-inv', { foo: 'bar' });

      await invalidateKeyReserveCache('key-inv');

      expect(cacheStore.has('key:reserve:key-inv')).toBe(false);
   });
});
