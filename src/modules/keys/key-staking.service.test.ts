// src/modules/keys/key-staking.service.test.ts
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
import { getKeyStaking, KeyNotFoundError, invalidateKeyStakingCache } from './key-staking.service';
import { REDIS_KEYS } from '../../constants/notifications.constants';

describe('key-staking.service', () => {
   beforeEach(() => {
      redisStore.clear();
      jest.clearAllMocks();
   });

   it('returns zeroed staking pool when no on-chain state is available', async () => {
      (prisma.creatorProfile.findUnique as jest.Mock).mockResolvedValue({ id: 'key-1' });

      const staking = await getKeyStaking('key-1');
      expect(staking).toEqual({
         stakingPoolBalance: '0',
         totalStaked: '0',
         recentFeeInflow: '0',
         stakerCount: 0,
      });
   });

   it('caches the result in Redis', async () => {
      (prisma.creatorProfile.findUnique as jest.Mock).mockResolvedValue({ id: 'key-1' });

      await getKeyStaking('key-1');
      expect(redisStore.has(REDIS_KEYS.keyStaking('key-1'))).toBe(true);
   });

   it('serves from cache on subsequent calls', async () => {
      (prisma.creatorProfile.findUnique as jest.Mock).mockResolvedValue({ id: 'key-1' });

      await getKeyStaking('key-1');
      (prisma.creatorProfile.findUnique as jest.Mock).mockClear();

      const cached = await getKeyStaking('key-1');
      expect(cached.totalStaked).toBe('0');
      expect(prisma.creatorProfile.findUnique).not.toHaveBeenCalled();
   });

   it('throws KeyNotFoundError for unknown key IDs', async () => {
      (prisma.creatorProfile.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(getKeyStaking('missing')).rejects.toBeInstanceOf(KeyNotFoundError);
   });

   it('invalidation removes the cached entry', async () => {
      (prisma.creatorProfile.findUnique as jest.Mock).mockResolvedValue({ id: 'key-1' });
      await getKeyStaking('key-1');
      expect(redisStore.has(REDIS_KEYS.keyStaking('key-1'))).toBe(true);

      await invalidateKeyStakingCache('key-1');
      expect(redisStore.has(REDIS_KEYS.keyStaking('key-1'))).toBe(false);
   });
});
