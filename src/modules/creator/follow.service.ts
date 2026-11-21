import { prisma } from '../../utils/prisma.utils';

export interface FollowResult {
   creatorId: string;
   followerAddress: string;
   action: 'followed' | 'already_following';
   followersCount: number;
}

export interface UnfollowResult {
   creatorId: string;
   followerAddress: string;
   action: 'unfollowed' | 'not_following';
   followersCount: number;
}

export async function followCreator(
   creatorId: string,
   followerAddress: string
): Promise<FollowResult> {
   const existing = await prisma.follow.findUnique({
      where: {
         followerAddress_creatorId: {
            followerAddress,
            creatorId,
         },
      },
   });

   if (existing) {
      const profile = await prisma.creatorProfile.findUnique({
         where: { id: creatorId },
         select: { followersCount: true },
      });

      return {
         creatorId,
         followerAddress,
         action: 'already_following',
         followersCount: profile?.followersCount ?? 0,
      };
   }

   const result = await prisma.$transaction(async (tx) => {
      await tx.follow.create({
         data: {
            followerAddress,
            creatorId,
         },
      });

      const updated = await tx.creatorProfile.update({
         where: { id: creatorId },
         data: { followersCount: { increment: 1 } },
         select: { followersCount: true },
      });

      return updated;
   });

   return {
      creatorId,
      followerAddress,
      action: 'followed',
      followersCount: result.followersCount,
   };
}

export async function unfollowCreator(
   creatorId: string,
   followerAddress: string
): Promise<UnfollowResult> {
   const existing = await prisma.follow.findUnique({
      where: {
         followerAddress_creatorId: {
            followerAddress,
            creatorId,
         },
      },
   });

   if (!existing) {
      const profile = await prisma.creatorProfile.findUnique({
         where: { id: creatorId },
         select: { followersCount: true },
      });

      return {
         creatorId,
         followerAddress,
         action: 'not_following',
         followersCount: profile?.followersCount ?? 0,
      };
   }

   const result = await prisma.$transaction(async (tx) => {
      await tx.follow.delete({
         where: {
            followerAddress_creatorId: {
               followerAddress,
               creatorId,
            },
         },
      });

      const updated = await tx.creatorProfile.update({
         where: { id: creatorId },
         data: { followersCount: { decrement: 1 } },
         select: { followersCount: true },
      });

      return updated;
   });

   return {
      creatorId,
      followerAddress,
      action: 'unfollowed',
      followersCount: Math.max(0, result.followersCount),
   };
}

export async function getFollowerCount(creatorId: string): Promise<number> {
   const profile = await prisma.creatorProfile.findUnique({
      where: { id: creatorId },
      select: { followersCount: true },
   });
   return profile?.followersCount ?? 0;
}
