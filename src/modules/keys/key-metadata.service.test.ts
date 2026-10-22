// src/modules/keys/key-metadata.service.test.ts
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
import { getKeyMetadata, KeyNotFoundError, invalidateKeyMetadataCache } from './key-metadata.service';
import { REDIS_KEYS } from '../../constants/notifications.constants';

describe('key-metadata.service', () => {
   beforeEach(() => {
      redisStore.clear();
      jest.clearAllMocks();
   });

   it('returns metadata from DB when no on-chain metadata is available', async () => {
      (prisma.creatorProfile.findUnique as jest.Mock).mockResolvedValue({
         id: 'key-1',
         displayName: 'Alice',
         bio: 'Creator bio',
         avatarUrl: 'https://example.com/avatar.png',
         userId: 'wallet-alice',
      });

      const metadata = await getKeyMetadata('key-1');
      expect(metadata).toEqual({
         name: 'Alice',
         bio: 'Creator bio',
         avatarUri: 'https://example.com/avatar.png',
         creatorAddress: 'wallet-alice',
      });
   });

   it('handles null bio and avatarUri from DB', async () => {
      (prisma.creatorProfile.findUnique as jest.Mock).mockResolvedValue({
         id: 'key-2',
         displayName: 'Bob',
         bio: null,
         avatarUrl: null,
         userId: 'wallet-bob',
      });

      const metadata = await getKeyMetadata('key-2');
      expect(metadata.name).toBe('Bob');
      expect(metadata.bio).toBeNull();
      expect(metadata.avatarUri).toBeNull();
      expect(metadata.creatorAddress).toBe('wallet-bob');
   });

   it('caches the result in Redis', async () => {
      (prisma.creatorProfile.findUnique as jest.Mock).mockResolvedValue({
         id: 'key-1',
         displayName: 'Alice',
         bio: null,
         avatarUrl: null,
         userId: 'wallet-alice',
      });

      await getKeyMetadata('key-1');
      expect(redisStore.has(REDIS_KEYS.keyMetadata('key-1'))).toBe(true);
   });

   it('serves from cache on subsequent calls', async () => {
      (prisma.creatorProfile.findUnique as jest.Mock).mockResolvedValue({
         id: 'key-1',
         displayName: 'Alice',
         bio: null,
         avatarUrl: null,
         userId: 'wallet-alice',
      });

      await getKeyMetadata('key-1');
      (prisma.creatorProfile.findUnique as jest.Mock).mockClear();

      const cached = await getKeyMetadata('key-1');
      expect(cached.name).toBe('Alice');
      expect(prisma.creatorProfile.findUnique).not.toHaveBeenCalled();
   });

   it('throws KeyNotFoundError for unknown key IDs', async () => {
      (prisma.creatorProfile.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(getKeyMetadata('missing')).rejects.toBeInstanceOf(KeyNotFoundError);
   });

   it('invalidation removes the cached entry', async () => {
      (prisma.creatorProfile.findUnique as jest.Mock).mockResolvedValue({
         id: 'key-1',
         displayName: 'Alice',
         bio: null,
         avatarUrl: null,
         userId: 'wallet-alice',
      });
      await getKeyMetadata('key-1');
      expect(redisStore.has(REDIS_KEYS.keyMetadata('key-1'))).toBe(true);

      await invalidateKeyMetadataCache('key-1');
      expect(redisStore.has(REDIS_KEYS.keyMetadata('key-1'))).toBe(false);
   });
});
