// src/modules/keys/key-holding-capacity.service.test.ts
const redisStore = new Map<string, { value: unknown; ttl: number }>();

jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn(async (key: string) =>
      redisStore.has(key) ? redisStore.get(key)!.value : null
   ),
   cacheSetJson: jest.fn(async (key: string, value: unknown, ttl: number) => {
      redisStore.set(key, { value, ttl });
   }),
}));

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      creatorProfile: { findFirst: jest.fn() },
      keyOwnership: { findUnique: jest.fn() },
   },
}));

import { prisma } from '../../utils/prisma.utils';
import { KeyNotFoundError } from './key-fees.service';
import {
   computeCapPercentage,
   computeHoldingCap,
   getKeyHoldingCapacity,
   HOLDING_CAPACITY_CACHE_TTL_SECONDS,
} from './key-holding-capacity.service';

const WALLET = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';

const mockPrisma = prisma as unknown as {
   creatorProfile: { findFirst: jest.Mock };
   keyOwnership: { findUnique: jest.Mock };
};

function mockKey(overrides: Record<string, unknown> = {}) {
   mockPrisma.creatorProfile.findFirst.mockResolvedValue({
      id: 'key-1',
      holderCapBps: 2500,
      supplyCap: 1000,
      circulatingSupply: '400',
      ...overrides,
   });
}

describe('key-holding-capacity.service', () => {
   beforeEach(() => {
      redisStore.clear();
      jest.clearAllMocks();
   });

   describe('computeHoldingCap', () => {
      it('applies holder_cap_bps to the configured supply cap', () => {
         expect(computeHoldingCap(2500, 1000, 400)).toBe(250);
      });

      it('falls back to circulating supply when the key is uncapped', () => {
         expect(computeHoldingCap(1000, null, 400)).toBe(40);
      });

      it('floors fractional caps to whole keys', () => {
         expect(computeHoldingCap(100, 150, 0)).toBe(1);
      });
   });

   describe('computeCapPercentage', () => {
      it('returns the held share rounded to 2 decimals', () => {
         expect(computeCapPercentage(1, 3)).toBe(33.33);
      });

      it('clamps to 100 when holding exceeds cap', () => {
         expect(computeCapPercentage(300, 250)).toBe(100);
      });

      it('handles a zero cap', () => {
         expect(computeCapPercentage(0, 0)).toBe(0);
         expect(computeCapPercentage(5, 0)).toBe(100);
      });
   });

   it('returns holding, cap, remaining and cap_percentage', async () => {
      mockKey();
      mockPrisma.keyOwnership.findUnique.mockResolvedValue({ balance: '100' });

      await expect(getKeyHoldingCapacity('key-1', WALLET)).resolves.toEqual({
         keyId: 'key-1',
         wallet: WALLET,
         current_holding: 100,
         cap: 250,
         remaining: 150,
         cap_percentage: 40,
      });
      expect(mockPrisma.keyOwnership.findUnique).toHaveBeenCalledWith({
         where: {
            ownerAddress_creatorId: {
               ownerAddress: WALLET,
               creatorId: 'key-1',
            },
         },
         select: { balance: true },
      });
   });

   it('treats a wallet with no position as zero holding', async () => {
      mockKey();
      mockPrisma.keyOwnership.findUnique.mockResolvedValue(null);

      const result = await getKeyHoldingCapacity('key-1', WALLET);
      expect(result.current_holding).toBe(0);
      expect(result.remaining).toBe(250);
      expect(result.cap_percentage).toBe(0);
   });

   it('never reports negative remaining when holding exceeds cap', async () => {
      mockKey({ holderCapBps: 100 });
      mockPrisma.keyOwnership.findUnique.mockResolvedValue({ balance: '50' });

      const result = await getKeyHoldingCapacity('key-1', WALLET);
      expect(result.cap).toBe(10);
      expect(result.remaining).toBe(0);
      expect(result.cap_percentage).toBe(100);
   });

   it('reflects the current key configuration cap', async () => {
      mockKey({ holderCapBps: 500 });
      mockPrisma.keyOwnership.findUnique.mockResolvedValue({ balance: '10' });

      const result = await getKeyHoldingCapacity('key-1', WALLET);
      expect(result.cap).toBe(50);
      expect(result.remaining).toBe(40);
   });

   it('throws KeyNotFoundError for an unknown key', async () => {
      mockPrisma.creatorProfile.findFirst.mockResolvedValue(null);

      await expect(getKeyHoldingCapacity('missing', WALLET)).rejects.toThrow(
         KeyNotFoundError
      );
      expect(mockPrisma.keyOwnership.findUnique).not.toHaveBeenCalled();
   });

   it('caches the response for 10s and serves repeat reads from cache', async () => {
      mockKey();
      mockPrisma.keyOwnership.findUnique.mockResolvedValue({ balance: '100' });

      const first = await getKeyHoldingCapacity('key-1', WALLET);
      const entry = redisStore.get(`keys:holding-capacity:key-1:${WALLET}`);
      expect(entry?.ttl).toBe(HOLDING_CAPACITY_CACHE_TTL_SECONDS);
      expect(HOLDING_CAPACITY_CACHE_TTL_SECONDS).toBe(10);

      const second = await getKeyHoldingCapacity('key-1', WALLET);
      expect(second).toEqual(first);
      expect(mockPrisma.creatorProfile.findFirst).toHaveBeenCalledTimes(1);
      expect(mockPrisma.keyOwnership.findUnique).toHaveBeenCalledTimes(1);
   });
});
