import { prisma } from '../../utils/prisma.utils';

/**
 * Returns posts from creators followed by the given wallet, newest first.
 */
export async function fetchWalletFeed(walletAddress: string) {
   const posts = await prisma.creatorPost.findMany({
      where: {
         creator: {
            walletFollowers: {
               some: { walletAddress },
            },
         },
      },
      select: {
         id: true,
         content: true,
         createdAt: true,
         creator: {
            select: {
               user: {
                  select: {
                     stellarWallet: {
                        select: { address: true },
                     },
                  },
               },
            },
         },
      },
      orderBy: { createdAt: 'desc' },
   });

   return posts.map(post => ({
      id: post.id,
      content: post.content,
      creator_wallet: post.creator.user.stellarWallet?.address ?? null,
      created_at: post.createdAt.toISOString(),
   }));
}
