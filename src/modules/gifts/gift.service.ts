import { prisma } from '../../utils/prisma.utils';
import { giftVerificationService } from './gift-verification.service';
import type { CreateGiftInput } from './gift.schemas';

export class GiftError extends Error {
   constructor(
      message: string,
      public readonly status: 400 | 403 | 404 | 409
   ) {
      super(message);
      this.name = 'GiftError';
   }
}

export class GiftService {
   /**
    * Verifies the transfer on-chain and persists the gift record.
    * Duplicate txHash values are rejected with 409.
    */
   async createGift(input: CreateGiftInput) {
      const existing = await prisma.gift.findUnique({
         where: { txHash: input.txHash },
      });
      if (existing) {
         throw new GiftError('Gift for this transaction already exists', 409);
      }

      try {
         await giftVerificationService.verify(
            input.txHash,
            input.sender,
            input.recipient,
            input.quantity,
            input.keyId
         );
      } catch (err) {
         throw new GiftError(
            (err as Error).message || 'Transfer verification failed',
            400
         );
      }

      try {
         return await prisma.gift.create({
            data: {
               txHash: input.txHash,
               keyId: input.keyId,
               quantity: input.quantity,
               sender: input.sender,
               recipient: input.recipient,
               message: input.message,
            },
         });
      } catch (err: any) {
         // Prisma unique constraint violation (race between check and insert)
         if (err?.code === 'P2002') {
            throw new GiftError('Gift for this transaction already exists', 409);
         }
         throw err;
      }
   }

   /**
    * Lists gifts received by a wallet. When unseen is true, only gifts with a
    * null seenAt are returned.
    */
   async listReceivedGifts(address: string, unseen: boolean) {
      return prisma.gift.findMany({
         where: {
            recipient: address,
            ...(unseen ? { seenAt: null } : {}),
         },
         orderBy: { createdAt: 'desc' },
      });
   }

   /**
    * Marks a gift as seen. Only the recipient may do so.
    */
   async markSeen(id: string, requesterAddress: string) {
      const gift = await prisma.gift.findUnique({ where: { id } });
      if (!gift) {
         throw new GiftError('Gift not found', 404);
      }
      if (gift.recipient !== requesterAddress) {
         throw new GiftError('Only the recipient can mark this gift as seen', 403);
      }
      if (gift.seenAt) {
         return gift;
      }
      return prisma.gift.update({
         where: { id },
         data: { seenAt: new Date() },
      });
   }
}

export const giftService = new GiftService();
