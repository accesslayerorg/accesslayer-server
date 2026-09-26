import { z } from 'zod';

export const WebhookEventEnum = z.enum(['buy', 'sell']);

/**
 * Callback URLs must be well-formed, HTTPS, and have a non-empty host —
 * webhook payloads carry trade data and are delivered over the network, so
 * plain-HTTP or hostless callback URLs are rejected outright (#613).
 */
export const CreateWebhookSchema = z.object({
   callback_url: z
      .string()
      .url('callback_url must be a valid URL')
      .refine(
         value => {
            try {
               return new URL(value).protocol === 'https:';
            } catch {
               return false;
            }
         },
         { message: 'callback_url must use https://' }
      )
      .refine(
         value => {
            try {
               return new URL(value).hostname.length > 0;
            } catch {
               return false;
            }
         },
         { message: 'callback_url must include a host' }
      ),
   events: z
      .array(WebhookEventEnum, { required_error: 'events is required' })
      .min(1, 'At least one event type is required'),
});

export const UpdateWebhookSchema = z.object({
   callback_url: z
      .string()
      .url('callback_url must be a valid URL')
      .refine(
         value => {
            try {
               return new URL(value).protocol === 'https:';
            } catch {
               return false;
            }
         },
         { message: 'callback_url must use https://' }
      )
      .refine(
         value => {
            try {
               return new URL(value).hostname.length > 0;
            } catch {
               return false;
            }
         },
         { message: 'callback_url must include a host' }
      )
      .optional(),
   events: z
      .array(WebhookEventEnum, { required_error: 'events is required' })
      .min(1, 'At least one event type is required')
      .optional(),
});

export type CreateWebhookType = z.infer<typeof CreateWebhookSchema>;
export type UpdateWebhookType = z.infer<typeof UpdateWebhookSchema>;
