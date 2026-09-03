// src/modules/keys/key-auction.service.test.ts
const redisStore = new Map<string, string>();

jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn(async (key: string) => {
      const raw = redisStore.get(key);
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { return null; }
   }),
   cacheSetJson: jest.fn(async (key: string, value: unknown, _ttl: number) => {
      redisStore.set(key, JSON.stringify(value));
   }),
   cacheInvalidate: jest.fn(async (...keys: string[]) => {
      for (const key of keys) redisStore.delete(key);
   }),
}));

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      creatorProfile: {
         findUnique: jest.fn(),
      },
   },
}));

import { prisma } from '../../utils/prisma.utils';
import { getKeyAuction, KeyNotFoundError, invalidateKeyAuctionCache } from './key-auction.service';
import { REDIS_KEYS } from '../../constants/notifications.constants';

describe('key-auction.service', () => {
   beforeEach(() => {
      redisStore.clear();
      jest.clearAllMocks();
   });

   it('returns not_configured auction state for an existing key with no on-chain auction', async () => {
      (prisma.creatorProfile.findUnique as jest.Mock).mockResolvedValue({ id: 'key-1' });

      const auction = await getKeyAuction('key-1');
      expect(auction).toEqual({
         auctionPrice: '0',
         auctionSupply: 0,
         auctionSold: 0,
         auctionStatus: 'not_configured',
      });
   });

   it('caches the result in Redis', async () => {
      (prisma.creatorProfile.findUnique as jest.Mock).mockResolvedValue({ id: 'key-1' });

      await getKeyAuction('key-1');
      expect(redisStore.has(REDIS_KEYS.keyAuction('key-1'))).toBe(true);
   });

   it('serves from cache on subsequent calls', async () => {
      (prisma.creatorProfile.findUnique as jest.Mock).mockResolvedValue({ id: 'key-1' });

      await getKeyAuction('key-1');
      (prisma.creatorProfile.findUnique as jest.Mock).mockClear();

      const cached = await getKeyAuction('key-1');
      expect(cached.auctionStatus).toBe('not_configured');
      expect(prisma.creatorProfile.findUnique).not.toHaveBeenCalled();
   });

   it('throws KeyNotFoundError for unknown key IDs', async () => {
      (prisma.creatorProfile.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(getKeyAuction('missing')).rejects.toBeInstanceOf(KeyNotFoundError);
   });

   it('invalidation removes the cached entry', async () => {
      (prisma.creatorProfile.findUnique as jest.Mock).mockResolvedValue({ id: 'key-1' });
      await getKeyAuction('key-1');
      expect(redisStore.has(REDIS_KEYS.keyAuction('key-1'))).toBe(true);

      await invalidateKeyAuctionCache('key-1');
      expect(redisStore.has(REDIS_KEYS.keyAuction('key-1'))).toBe(false);
   });
});
