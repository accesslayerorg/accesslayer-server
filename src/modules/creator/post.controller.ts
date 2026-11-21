import type { Request, Response } from 'express';
import { z } from 'zod';
import type { StellarSignedRequest } from '../../middlewares/stellar-signature.middleware';
import { ErrorCode } from '../../constants/error.constants';
import { prisma } from '../../utils/prisma.utils';
import { sendError, sendSuccess } from '../../utils/api-response.utils';

export const postSchema = z.object({
   content: z.string().trim().min(1).max(5000),
});

export type CreatePostBody = z.infer<typeof postSchema>;

function serializePost(
   post: {
      id: string;
      content: string;
      createdAt: Date;
   },
   walletAddress: string | null
) {
   return {
      id: post.id,
      content: post.content,
      creator_wallet: walletAddress,
      created_at: post.createdAt.toISOString(),
   };
}

export async function httpCreatePost(
   req: StellarSignedRequest,
   res: Response
): Promise<void> {
   // Body is already validated and stripped of unknown fields by the
   // validateBody(postSchema) middleware on this route.
   const body = req.body as CreatePostBody;

   const creatorId = String(req.params.id);
   const creator = await prisma.creatorProfile.findFirst({
      where: {
         id: creatorId,
         user: { stellarWallet: { address: req.walletAddress } },
      },
   });
   if (!creator) {
      sendError(
         res,
         403,
         ErrorCode.NOT_A_CREATOR,
         'Authenticated wallet is not the requested creator'
      );
      return;
   }

   const post = await prisma.creatorPost.create({
      data: { creatorId: creator.id, content: body.content },
   });
   sendSuccess(res, serializePost(post, req.walletAddress!), 201);
}

export async function httpListPosts(
   req: Request,
   res: Response
): Promise<void> {
   const creatorId = String(req.params.id);
   const creator = await prisma.creatorProfile.findUnique({
      where: { id: creatorId },
      include: { user: { include: { stellarWallet: true } } },
   });
   const posts = await prisma.creatorPost.findMany({
      where: { creatorId },
      orderBy: { createdAt: 'desc' },
   });
   const walletAddress = creator?.user.stellarWallet?.address ?? null;
   sendSuccess(
      res,
      posts.map(post => serializePost(post, walletAddress))
   );
}
