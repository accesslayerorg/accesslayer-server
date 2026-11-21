import { z } from 'zod';
import { StellarAddressSchema } from '../wallet/wallet.schemas';
import { safeIntParam } from '../../utils/query.utils';

export const scheduledTransferParamsSchema = z.object({
   address: StellarAddressSchema,
});
export const scheduledTransferDirectionSchema = z.enum([
   'incoming', 'outgoing', 'all',
]);
export const scheduledTransferQuerySchema = z.object({
   direction: scheduledTransferDirectionSchema.default('all'),
   limit: safeIntParam({ defaultValue: 25, min: 1, max: 100, label: 'Limit' }),
   cursor: z.string().min(1).max(1024).regex(/^[A-Za-z0-9_-]+$/).optional(),
}).strict();

export type ScheduledTransferQuery = z.infer<typeof scheduledTransferQuerySchema>;

export const scheduledTransferCursorSchema = z.object({
   version: z.literal(1),
   address: StellarAddressSchema,
   direction: scheduledTransferDirectionSchema,
   ledger: z.number().int().nonnegative().max(2147483647),
   id: z.string().min(1).max(256),
}).strict();
