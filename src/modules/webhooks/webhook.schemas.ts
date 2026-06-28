import { z } from 'zod';

export const WebhookEventEnum = z.enum(['buy', 'sell']);

export const CreateWebhookSchema = z.object({
  callback_url: z.string().url('callback_url must be a valid URL'),
  events: z
    .array(WebhookEventEnum, { required_error: 'events is required' })
    .min(1, 'At least one event type is required'),
});

export type CreateWebhookType = z.infer<typeof CreateWebhookSchema>;
