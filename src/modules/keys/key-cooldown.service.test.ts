// src/modules/keys/key-cooldown.service.test.ts
const redisStore = new Map<string, { value: unknown; ttl: number }>();

jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn(async (key: string) =>
      redisStore.has(key) ? redisStore.get(key)!.value : null
   ),
   cacheSetJson: jest.fn(async (key: string, value: unknown, ttl: number) => {
      redisStore.set(key, { value, ttl });
   }),
   cacheInvalidate: jest.fn(async (...keys: string[]) => {
      for (const k of keys) {
         redisStore.delete(k);
      }
   }),
}));

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      creatorProfile: { findFirst: jest.fn() },
      trade: { findFirst: jest.fn() },
      indexedLedger: { findUnique: jest.fn() },
   },
}));

import { prisma } from '../../utils/prisma.utils';
import { KeyNotFoundError } from './key-fees.service';
import {
   getKeyCooldown,
   getBatchCooldowns,
   invalidateCooldownCache,
   cooldownCacheKey,
} from './key-cooldown.service';

const WALLET = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';

const mockPrisma = prisma as unknown as {
   creatorProfile: { findFirst: jest.Mock };
   trade: { findFirst: jest.Mock };
   indexedLedger: { findUnique: jest.Mock };
};

describe('key-cooldown.service', () => {
   beforeEach(() => {
      redisStore.clear();
      jest.clearAllMocks();
   });

   it('throws KeyNotFoundError when creator does not exist', async () => {
      mockPrisma.creatorProfile.findFirst.mockResolvedValue(null);
      await expect(getKeyCooldown('missing', WALLET)).rejects.toThrow(
         KeyNotFoundError
      );
   });

   it('returns inactive when cooldownLedgers is 0', async () => {
      mockPrisma.creatorProfile.findFirst.mockResolvedValue({
         id: 'key-1',
         cooldownLedgers: 0,
      });

      const status = await getKeyCooldown('key-1', WALLET);
      expect(status).toEqual({
         key_id: 'key-1',
         wallet: WALLET,
         active: false,
         cooldown_active: false,
         expires_at: null,
         unlock_estimated_at: null,
         seconds_remaining: 0,
         remaining_seconds: 0,
         cooldown_ledgers: 0,
         cooldown_seconds: 0,
      });
      expect(mockPrisma.trade.findFirst).not.toHaveBeenCalled();
   });

   it('returns active status when within cooldown window', async () => {
      mockPrisma.creatorProfile.findFirst.mockResolvedValue({
         id: 'key-1',
         cooldownLedgers: 10, // 10 ledgers = 50 seconds
      });
      mockPrisma.trade.findFirst.mockResolvedValue({ ledger: 100 });
      mockPrisma.indexedLedger.findUnique.mockResolvedValue({ ledger: 105 }); // 100 + 10 - 105 = 5 ledgers remaining = 25s

      const status = await getKeyCooldown('key-1', WALLET);
      expect(status.active).toBe(true);
      expect(status.cooldown_active).toBe(true);
      expect(status.seconds_remaining).toBe(25);
      expect(status.remaining_seconds).toBe(25);
      expect(status.cooldown_ledgers).toBe(10);
      expect(status.cooldown_seconds).toBe(50);
      expect(status.expires_at).not.toBeNull();
   });

   it('returns inactive status when cooldown window has elapsed', async () => {
      mockPrisma.creatorProfile.findFirst.mockResolvedValue({
         id: 'key-1',
         cooldownLedgers: 10,
      });
      mockPrisma.trade.findFirst.mockResolvedValue({ ledger: 100 });
      mockPrisma.indexedLedger.findUnique.mockResolvedValue({ ledger: 115 }); // 100 + 10 - 115 = -5 (expired)

      const status = await getKeyCooldown('key-1', WALLET);
      expect(status.active).toBe(false);
      expect(status.seconds_remaining).toBe(0);
      expect(status.cooldown_ledgers).toBe(10);
      expect(status.cooldown_seconds).toBe(50);
   });

   it('handles batch cooldown requests up to 50 keys', async () => {
      mockPrisma.creatorProfile.findFirst.mockResolvedValue({
         id: 'key-1',
         cooldownLedgers: 0,
      });
      const keys = Array.from({ length: 5 }, (_, i) => `key-${i + 1}`);

      const results = await getBatchCooldowns(keys, WALLET);
      expect(results).toHaveLength(5);
      expect(results[0].key_id).toBe('key-1');
   });

   it('rejects batch requests exceeding 50 keys', async () => {
      const keys = Array.from({ length: 51 }, (_, i) => `key-${i + 1}`);
      await expect(getBatchCooldowns(keys, WALLET)).rejects.toThrow(
         'Batch request exceeds maximum of 50 key IDs'
      );
   });

   it('invalidates cooldown cache', async () => {
      mockPrisma.creatorProfile.findFirst.mockResolvedValue({ id: 'key-1' });
      const cacheKey = cooldownCacheKey('key-1', WALLET.toLowerCase());
      redisStore.set(cacheKey, { value: { active: true }, ttl: 30 });

      await invalidateCooldownCache('key-1', WALLET);
      expect(redisStore.has(cacheKey)).toBe(false);
   });
});
