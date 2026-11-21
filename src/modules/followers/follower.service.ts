import { prisma } from '../../utils/prisma.utils';
import { getRedis } from '../../utils/redis.utils';
import { envConfig } from '../../config';
import { logger } from '../../utils/logger.utils';

function cacheKey(creatorWallet: string): string {
   return `follower_count:${creatorWallet}`;
}

export function getLocalNodeId(): string {
   return envConfig.NODE_ID || 'node-local';
}

export async function invalidateFollowerCountCache(creatorWallet: string): Promise<void> {
   try {
      const redis = getRedis();
      if (redis) {
         await redis.del(cacheKey(creatorWallet));
      }
   } catch {
      // Redis errors in tests/non-redis env should not crash operations
   }
}

export async function follow(
   followerWallet: string,
   creatorWallet: string,
   overrideNodeId?: string
): Promise<{ followed: boolean }> {
   const nodeId = overrideNodeId || getLocalNodeId();

   const existing = await prisma.followEvent.findUnique({
      where: {
         followerWallet_creatorWallet: {
            followerWallet,
            creatorWallet,
         },
      },
   });

   if (existing && existing.direction === 'FOLLOW') {
      return { followed: false };
   }

   await prisma.followEvent.upsert({
      where: {
         followerWallet_creatorWallet: {
            followerWallet,
            creatorWallet,
         },
      },
      update: { direction: 'FOLLOW' },
      create: {
         followerWallet,
         creatorWallet,
         direction: 'FOLLOW',
      },
   });

   try {
      await prisma.$executeRaw`
         INSERT INTO follower_counter_shards ("id", "creatorWallet", "nodeId", "increments", "decrements", "updatedAt")
         VALUES (gen_random_uuid()::text, ${creatorWallet}, ${nodeId}, 1, 0, NOW())
         ON CONFLICT ("creatorWallet", "nodeId")
         DO UPDATE SET "increments" = follower_counter_shards."increments" + 1, "updatedAt" = NOW()
      `;
   } catch {
      // Fallback for mocked Prisma / SQLite / non-postgres test environments
      const shard = await prisma.followerCounterShard.findUnique({
         where: { creatorWallet_nodeId: { creatorWallet, nodeId } },
      });
      if (shard) {
         await prisma.followerCounterShard.update({
            where: { creatorWallet_nodeId: { creatorWallet, nodeId } },
            data: { increments: { increment: 1 } },
         });
      } else {
         await prisma.followerCounterShard.create({
            data: {
               creatorWallet,
               nodeId,
               increments: 1n,
               decrements: 0n,
            },
         });
      }
   }

   await invalidateFollowerCountCache(creatorWallet);
   return { followed: true };
}

export async function unfollow(
   followerWallet: string,
   creatorWallet: string,
   overrideNodeId?: string
): Promise<{ unfollowed: boolean }> {
   const nodeId = overrideNodeId || getLocalNodeId();

   const existing = await prisma.followEvent.findUnique({
      where: {
         followerWallet_creatorWallet: {
            followerWallet,
            creatorWallet,
         },
      },
   });

   if (!existing || existing.direction === 'UNFOLLOW') {
      return { unfollowed: false };
   }

   await prisma.followEvent.update({
      where: {
         followerWallet_creatorWallet: {
            followerWallet,
            creatorWallet,
         },
      },
      data: { direction: 'UNFOLLOW' },
   });

   try {
      await prisma.$executeRaw`
         INSERT INTO follower_counter_shards ("id", "creatorWallet", "nodeId", "increments", "decrements", "updatedAt")
         VALUES (gen_random_uuid()::text, ${creatorWallet}, ${nodeId}, 0, 1, NOW())
         ON CONFLICT ("creatorWallet", "nodeId")
         DO UPDATE SET "decrements" = follower_counter_shards."decrements" + 1, "updatedAt" = NOW()
      `;
   } catch {
      // Fallback for mocked Prisma / SQLite / non-postgres test environments
      const shard = await prisma.followerCounterShard.findUnique({
         where: { creatorWallet_nodeId: { creatorWallet, nodeId } },
      });
      if (shard) {
         await prisma.followerCounterShard.update({
            where: { creatorWallet_nodeId: { creatorWallet, nodeId } },
            data: { decrements: { increment: 1 } },
         });
      } else {
         await prisma.followerCounterShard.create({
            data: {
               creatorWallet,
               nodeId,
               increments: 0n,
               decrements: 1n,
            },
         });
      }
   }

   await invalidateFollowerCountCache(creatorWallet);
   return { unfollowed: true };
}

export async function getFollowerCount(creatorWallet: string): Promise<number> {
   try {
      const redis = getRedis();
      if (redis) {
         const cached = await redis.get(cacheKey(creatorWallet));
         if (cached !== null) {
            return parseInt(cached, 10);
         }
      }
   } catch {
      // Redis fallback
   }

   const shards = await prisma.followerCounterShard.findMany({
      where: { creatorWallet },
   });

   let totalIncrements = 0n;
   let totalDecrements = 0n;

   for (const shard of shards) {
      totalIncrements += BigInt(shard.increments);
      totalDecrements += BigInt(shard.decrements);
   }

   const diff = totalIncrements - totalDecrements;
   const count = diff > 0n ? Number(diff) : 0;

   try {
      const redis = getRedis();
      if (redis) {
         await redis.set(cacheKey(creatorWallet), count.toString(), 'EX', 10);
      }
   } catch {
      // Redis fallback
   }

   return count;
}

export async function compactShardsForCreator(creatorWallet: string): Promise<boolean> {
   const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

   const recentActivity = await prisma.followerCounterShard.findFirst({
      where: {
         creatorWallet,
         updatedAt: { gte: fiveMinutesAgo },
      },
   });

   if (recentActivity) {
      logger.debug(
         { creator_wallet: creatorWallet },
         'Skipping compaction due to recent activity in the last 5 minutes'
      );
      return false;
   }

   const shards = await prisma.followerCounterShard.findMany({
      where: { creatorWallet },
   });

   if (shards.length === 0) {
      return false;
   }

   let totalIncrements = 0n;
   let totalDecrements = 0n;

   for (const shard of shards) {
      totalIncrements += BigInt(shard.increments);
      totalDecrements += BigInt(shard.decrements);
   }

   await prisma.$transaction([
      prisma.followerCounterShard.deleteMany({
         where: { creatorWallet },
      }),
      prisma.followerCounterShard.create({
         data: {
            creatorWallet,
            nodeId: 'canonical_shard',
            increments: totalIncrements,
            decrements: totalDecrements,
         },
      }),
   ]);

   logger.info(
      { creator_wallet: creatorWallet, total_shards_compacted: shards.length },
      'Follower counter shards compacted atomically'
   );

   return true;
}
