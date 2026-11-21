import { z } from 'zod';

export const MAX_MESSAGE_LENGTH = 140;

export const MESSAGE_TOO_LONG_ERROR = `Message must be at most ${MAX_MESSAGE_LENGTH} characters`;

export const createGiftSchema = z.object({
   txHash: z.string().min(1),
   keyId: z.string().min(1),
   quantity: z.number().int().positive(),
   sender: z.string().min(1),
   recipient: z.string().min(1),
   message: z
      .string()
      .max(MAX_MESSAGE_LENGTH, MESSAGE_TOO_LONG_ERROR)
      .default(''),
});

export const listReceivedGiftsQuerySchema = z.object({
   unseen: z
      .enum(['true', 'false'])
      .optional()
      .transform(v => v === 'true'),
});

export const giftIdParamSchema = z.object({
   id: z.string().min(1),
});

export const walletAddressParamSchema = z.object({
   address: z.string().min(1),
});

export type CreateGiftInput = z.infer<typeof createGiftSchema>;
