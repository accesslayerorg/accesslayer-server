import { z } from 'zod';

export const RegisterWebhookSchema = z.object({
    url: z.string().url('Invalid webhook URL'),
    events: z.array(z.enum(['buy', 'sell'])).min(1, 'At least one event is required'),
}).strict();

export type RegisterWebhookInput = z.infer<typeof RegisterWebhookSchema>;

export const SimulateTradeSchema = z.object({
    type: z.enum(['buy', 'sell']),
    amount: z.coerce.number().positive(),
    price: z.coerce.number().positive(),
    creatorId: z.string().min(1, 'creatorId is required'),
    actor: z.string().min(1, 'actor is required'),
}).strict();

export type SimulateTradeInput = z.infer<typeof SimulateTradeSchema>;
