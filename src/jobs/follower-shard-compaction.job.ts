import { prisma } from '../utils/prisma.utils';
import { compactShardsForCreator } from '../modules/followers/follower.service';
import { logger } from '../utils/logger.utils';

export async function runNightlyFollowerShardCompaction(): Promise<{
   creatorsCompacted: number;
}> {
   logger.info('Starting nightly follower shard compaction job');

   const creators = await prisma.followerCounterShard.findMany({
      distinct: ['creatorWallet'],
      select: { creatorWallet: true },
   });

   let count = 0;
   for (const { creatorWallet } of creators) {
      const compacted = await compactShardsForCreator(creatorWallet);
      if (compacted) {
         count++;
      }
   }

   logger.info(
      { creators_compacted: count, total_creators_evaluated: creators.length },
      'Nightly follower shard compaction completed'
   );

   return { creatorsCompacted: count };
}
