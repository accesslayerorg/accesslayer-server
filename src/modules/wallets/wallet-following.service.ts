// src/modules/wallets/wallet-following.service.ts
import { prisma } from '../../utils/prisma.utils';

/**
 * Returns all creators that the given wallet follows, ordered
 * alphabetically by display name.
 */
export async function fetchWalletFollowing(walletAddress: string) {
   const follows = await prisma.walletCreatorFollow.findMany({
      where: { walletAddress },
      select: {
         creatorId: true,
         createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
   });

   if (follows.length === 0) {
      return [];
   }

   const creatorIds = follows.map((f) => f.creatorId);

   const creators = await prisma.creatorProfile.findMany({
      where: { id: { in: creatorIds } },
      select: {
         id: true,
         handle: true,
         displayName: true,
         avatarUrl: true,
      },
   });

   // Sort by displayName alphabetically (case-insensitive).
   creators.sort((a, b) =>
      a.displayName.localeCompare(b.displayName, undefined, {
         sensitivity: 'base',
      })
   );

   return creators;
}
