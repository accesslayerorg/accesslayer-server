import { z } from 'zod';

export const TRADE_NOTE_MAX_BODY_LENGTH = 4000;
export const TRADE_NOTE_MAX_TAGS = 8;
export const TRADE_NOTE_MAX_TAG_LENGTH = 64;

export const txHashParamSchema = z
   .string()
   .trim()
   .min(1, 'txHash is required')
   .max(128, 'txHash is too long');

export const upsertTradeNoteSchema = z.object({
   body: z
      .string({ required_error: 'body is required' })
      .trim()
      .min(1, 'Note body cannot be empty')
      .max(
         TRADE_NOTE_MAX_BODY_LENGTH,
         `Note body cannot exceed ${TRADE_NOTE_MAX_BODY_LENGTH} characters`
      ),
   tags: z
      .array(
         z
            .string()
            .trim()
            .min(1, 'Tags cannot be empty')
            .max(
               TRADE_NOTE_MAX_TAG_LENGTH,
               `Each tag cannot exceed ${TRADE_NOTE_MAX_TAG_LENGTH} characters`
            )
      )
      .max(
         TRADE_NOTE_MAX_TAGS,
         `Cannot attach more than ${TRADE_NOTE_MAX_TAGS} tags`
      )
      .optional()
      .default([]),
});

export const listTradeNotesQuerySchema = z.object({
   tag: z.string().trim().min(1).max(TRADE_NOTE_MAX_TAG_LENGTH).optional(),
   keyId: z.string().trim().min(1).max(128).optional(),
   cursor: z.string().trim().min(1).optional(),
   limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});

export type UpsertTradeNoteInput = z.infer<typeof upsertTradeNoteSchema>;
export type ListTradeNotesQuery = z.infer<typeof listTradeNotesQuerySchema>;
