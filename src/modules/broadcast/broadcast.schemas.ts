import { z } from 'zod';

export const UpdateBroadcastConsentBodySchema = z.object({
   email: z.string().trim().email('Valid email is required'),
   optIn: z.boolean(),
});

export const PreviewBroadcastBodySchema = z.object({
   minBalance: z.coerce.number().min(0).default(0),
});

export const CreateBroadcastBodySchema = z.object({
   subject: z.string().trim().min(1).max(200),
   bodyHtml: z.string().trim().min(1).max(50_000),
   bodyText: z.string().trim().max(50_000).optional(),
   minBalance: z.coerce.number().min(0).default(0),
   scheduledFor: z
      .string()
      .refine((v) => !Number.isNaN(Date.parse(v)), 'Invalid scheduledFor date')
      .optional(),
});

export const BounceWebhookBodySchema = z.object({
   email: z.string().trim().email(),
   type: z.enum(['BOUNCE', 'COMPLAINT']),
});
