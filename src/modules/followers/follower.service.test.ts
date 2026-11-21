import {
   follow,
   unfollow,
   getFollowerCount,
   compactShardsForCreator,
} from './follower.service';
import { prisma } from '../../utils/prisma.utils';

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
   },
}));

// In-memory mock for Prisma to test CRDT logic isolated from real DB
jest.mock('../../utils/prisma.utils', () => {
   const followEvents = new Map<string, { followerWallet: string; creatorWallet: string; direction: string }>();
   const shards = new Map<string, { id: string; creatorWallet: string; nodeId: string; increments: bigint; decrements: bigint; updatedAt: Date }>();

   return {
      prisma: {
         followEvent: {
            findUnique: jest.fn().mockImplementation(async ({ where }) => {
               const key = `${where.followerWallet_creatorWallet.followerWallet}:${where.followerWallet_creatorWallet.creatorWallet}`;
               return followEvents.get(key) || null;
            }),
            upsert: jest.fn().mockImplementation(async ({ where, update, create }) => {
               const key = `${where.followerWallet_creatorWallet.followerWallet}:${where.followerWallet_creatorWallet.creatorWallet}`;
               const existing = followEvents.get(key);
               const direction = existing ? update.direction : create.direction;
               const record = {
                  followerWallet: where.followerWallet_creatorWallet.followerWallet,
                  creatorWallet: where.followerWallet_creatorWallet.creatorWallet,
                  direction,
               };
               followEvents.set(key, record);
               return record;
            }),
            update: jest.fn().mockImplementation(async ({ where, data }) => {
               const key = `${where.followerWallet_creatorWallet.followerWallet}:${where.followerWallet_creatorWallet.creatorWallet}`;
               const existing = followEvents.get(key);
               if (existing) {
                  existing.direction = data.direction;
               }
               return existing;
            }),
         },
         followerCounterShard: {
            findUnique: jest.fn().mockImplementation(async ({ where }) => {
               const key = `${where.creatorWallet_nodeId.creatorWallet}:${where.creatorWallet_nodeId.nodeId}`;
               return shards.get(key) || null;
            }),
            findMany: jest.fn().mockImplementation(async ({ where }) => {
               const list = Array.from(shards.values()).filter(
                  s => s.creatorWallet === where.creatorWallet
               );
               if (where.updatedAt?.gte) {
                  return list.filter(s => s.updatedAt >= where.updatedAt.gte);
               }
               return list;
            }),
            findFirst: jest.fn().mockImplementation(async ({ where }) => {
               const list = Array.from(shards.values()).filter(
                  s => s.creatorWallet === where.creatorWallet
               );
               if (where.updatedAt?.gte) {
                  return list.find(s => s.updatedAt >= where.updatedAt.gte) || null;
               }
               return list[0] || null;
            }),
            create: jest.fn().mockImplementation(async ({ data }) => {
               const key = `${data.creatorWallet}:${data.nodeId}`;
               let record = shards.get(key);
               if (record) {
                  record.increments += BigInt(data.increments ?? 0);
                  record.decrements += BigInt(data.decrements ?? 0);
               } else {
                  record = {
                     id: key,
                     creatorWallet: data.creatorWallet,
                     nodeId: data.nodeId,
                     increments: BigInt(data.increments ?? 0),
                     decrements: BigInt(data.decrements ?? 0),
                     updatedAt: new Date(),
                  };
                  shards.set(key, record);
               }
               return record;
            }),
            update: jest.fn().mockImplementation(async ({ where, data }) => {
               const key = `${where.creatorWallet_nodeId.creatorWallet}:${where.creatorWallet_nodeId.nodeId}`;
               let record = shards.get(key);
               if (!record) {
                  record = {
                     id: key,
                     creatorWallet: where.creatorWallet_nodeId.creatorWallet,
                     nodeId: where.creatorWallet_nodeId.nodeId,
                     increments: 0n,
                     decrements: 0n,
                     updatedAt: new Date(),
                  };
                  shards.set(key, record);
               }
               if (data.increments?.increment) {
                  record.increments += BigInt(data.increments.increment);
               }
               if (data.decrements?.increment) {
                  record.decrements += BigInt(data.decrements.increment);
               }
               record.updatedAt = new Date();
               return record;
            }),
            deleteMany: jest.fn().mockImplementation(async ({ where }) => {
               for (const [key, shard] of shards.entries()) {
                  if (shard.creatorWallet === where.creatorWallet) {
                     shards.delete(key);
                  }
               }
               return { count: 1 };
            }),
         },
         $executeRaw: jest.fn().mockRejectedValue(new Error('raw query fallback')),
         $transaction: jest.fn().mockImplementation(async (actions) => Promise.all(actions)),
         _reset: () => {
            followEvents.clear();
            shards.clear();
         },
      },
   };
});

jest.mock('../../utils/redis.utils', () => {
   const redisStore = new Map<string, string>();
   return {
      getRedis: () => ({
         get: jest.fn().mockImplementation(async (key: string) => redisStore.get(key) ?? null),
         set: jest.fn().mockImplementation(async (key: string, val: string) => {
            redisStore.set(key, val);
            return 'OK';
         }),
         del: jest.fn().mockImplementation(async (key: string) => {
            redisStore.delete(key);
            return 1;
         }),
      }),
   };
});

describe('CRDT Follower Counter (#757)', () => {
   const creatorWallet = 'GCREATOR_CRDT_TEST';

   beforeEach(() => {
      (prisma as any)._reset();
      jest.clearAllMocks();
   });

   it('100 concurrent follows from different wallets produces count of exactly 100', async () => {
      const promises = Array.from({ length: 100 }, (_, i) =>
         follow(`follower-wallet-${i}`, creatorWallet, 'node-1')
      );

      await Promise.all(promises);

      const count = await getFollowerCount(creatorWallet);
      expect(count).toBe(100);
   });

   it('50 concurrent follows and 30 concurrent unfollows produces net count of 20', async () => {
      // First 50 follow
      const followPromises = Array.from({ length: 50 }, (_, i) =>
         follow(`follower-${i}`, creatorWallet, 'node-1')
      );
      await Promise.all(followPromises);

      // 30 of them unfollow
      const unfollowPromises = Array.from({ length: 30 }, (_, i) =>
         unfollow(`follower-${i}`, creatorWallet, 'node-1')
      );
      await Promise.all(unfollowPromises);

      const count = await getFollowerCount(creatorWallet);
      expect(count).toBe(20);
   });

   it('double-follow from the same wallet is idempotent and increments count only once', async () => {
      const first = await follow('wallet-alice', creatorWallet, 'node-1');
      const second = await follow('wallet-alice', creatorWallet, 'node-1');

      expect(first.followed).toBe(true);
      expect(second.followed).toBe(false);

      const count = await getFollowerCount(creatorWallet);
      expect(count).toBe(1);
   });

   it('sums counts across multiple node shards correctly', async () => {
      await follow('wallet-1', creatorWallet, 'node-alpha');
      await follow('wallet-2', creatorWallet, 'node-alpha');
      await follow('wallet-3', creatorWallet, 'node-beta');

      const count = await getFollowerCount(creatorWallet);
      expect(count).toBe(3);
   });

   it('nightly compaction merges shards atomically while maintaining identical resolved count', async () => {
      await follow('wallet-1', creatorWallet, 'node-1');
      await follow('wallet-2', creatorWallet, 'node-2');
      await follow('wallet-3', creatorWallet, 'node-3');

      const countBefore = await getFollowerCount(creatorWallet);
      expect(countBefore).toBe(3);

      // Mock Date.now to simulate 6 minutes passing so compaction is allowed
      const realNow = Date.now;
      jest.spyOn(Date, 'now').mockReturnValue(realNow() + 6 * 60 * 1000);

      const compacted = await compactShardsForCreator(creatorWallet);
      expect(compacted).toBe(true);

      const countAfter = await getFollowerCount(creatorWallet);
      expect(countAfter).toBe(3);

      jest.restoreAllMocks();
   });
});
