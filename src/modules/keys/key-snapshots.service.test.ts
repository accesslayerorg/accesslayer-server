const redisStore = new Map<string, { value: string; ttl: number }>();

jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn(async (key: string) => {
      const entry = redisStore.get(key);
      if (!entry) return null;
      try {
         return JSON.parse(entry.value);
      } catch {
         return null;
      }
   }),
   cacheSetJson: jest.fn(async (key: string, value: unknown, ttl: number) => {
      redisStore.set(key, { value: JSON.stringify(value), ttl });
   }),
   cacheInvalidate: jest.fn(async (...keys: string[]) => {
      for (const key of keys) redisStore.delete(key);
   }),
}));

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      creatorProfile: {
         findFirst: jest.fn(),
      },
      keySnapshot: {
         findMany: jest.fn(),
      },
   },
}));

import { prisma } from '../../utils/prisma.utils';
import {
   getKeySnapshots,
   invalidateKeySnapshotsCache,
   KeyNotFoundError,
} from './key-snapshots.service';
import { cacheSetJson, cacheInvalidate } from '../../utils/redis.utils';
import { KEY_SNAPSHOTS_CACHE_TTL_SECONDS } from '../../constants/notifications.constants';

describe('key-snapshots.service', () => {
   beforeEach(() => {
      redisStore.clear();
      jest.clearAllMocks();
   });

   describe('getKeySnapshots', () => {
      it('throws KeyNotFoundError for unknown key', async () => {
         (prisma.creatorProfile.findFirst as jest.Mock).mockResolvedValue(null);

         await expect(getKeySnapshots('unknown-key')).rejects.toBeInstanceOf(
            KeyNotFoundError
         );
      });

      it('returns empty array when key has no snapshots yet', async () => {
         (prisma.creatorProfile.findFirst as jest.Mock).mockResolvedValue({ id: 'key-1' });
         (prisma as any).keySnapshot.findMany.mockResolvedValue([]);

         const result = await getKeySnapshots('key-1');
         expect(result).toEqual([]);
         expect(cacheSetJson).toHaveBeenCalledWith(
            expect.stringContaining('key:snapshots:key-1:all'),
            [],
            KEY_SNAPSHOTS_CACHE_TTL_SECONDS
         );
      });

      it('returns snapshots and filters by range', async () => {
         (prisma.creatorProfile.findFirst as jest.Mock).mockResolvedValue({ id: 'key-1' });
         const now = new Date();
         const mockRows = [
            {
               date: now,
               price: '25.5000000',
               volume: '10000.0000000',
               holderCount: 150,
               marketCap: '255000.0000000',
            },
         ];
         (prisma as any).keySnapshot.findMany.mockResolvedValue(mockRows);

         const result = await getKeySnapshots('key-1', '7d');
         expect(result).toHaveLength(1);
         expect(result[0]).toEqual({
            date: now.toISOString(),
            price: '25.5000000',
            volume: '10000.0000000',
            holder_count: 150,
            market_cap: '255000.0000000',
         });

         expect((prisma as any).keySnapshot.findMany).toHaveBeenCalledWith({
            where: {
               keyId: 'key-1',
               date: { gte: expect.any(Date) },
            },
            orderBy: { date: 'asc' },
         });

         expect(cacheSetJson).toHaveBeenCalledWith(
            expect.stringContaining('key:snapshots:key-1:7d'),
            expect.any(Array),
            KEY_SNAPSHOTS_CACHE_TTL_SECONDS
         );
      });

      it('serves from Redis cache on subsequent calls', async () => {
         (prisma.creatorProfile.findFirst as jest.Mock).mockResolvedValue({ id: 'key-1' });
         (prisma as any).keySnapshot.findMany.mockResolvedValue([]);

         await getKeySnapshots('key-1', '30d');
         expect((prisma as any).keySnapshot.findMany).toHaveBeenCalledTimes(1);

         const cached = await getKeySnapshots('key-1', '30d');
         expect(cached).toEqual([]);
         expect((prisma as any).keySnapshot.findMany).toHaveBeenCalledTimes(1);
      });
   });

   describe('invalidateKeySnapshotsCache', () => {
      it('invalidates cache for all ranges', async () => {
         await invalidateKeySnapshotsCache('key-1');
         expect(cacheInvalidate).toHaveBeenCalledWith(
            expect.stringContaining('key:snapshots:key-1:7d')
         );
         expect(cacheInvalidate).toHaveBeenCalledWith(
            expect.stringContaining('key:snapshots:key-1:30d')
         );
         expect(cacheInvalidate).toHaveBeenCalledWith(
            expect.stringContaining('key:snapshots:key-1:90d')
         );
         expect(cacheInvalidate).toHaveBeenCalledWith(
            expect.stringContaining('key:snapshots:key-1:all')
         );
      });
   });
});
