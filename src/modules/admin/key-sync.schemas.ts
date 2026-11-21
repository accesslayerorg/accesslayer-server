import { z } from 'zod';

/**
 * Schema for individual field change in sync response.
 */
export const FieldChangeSchema = z.object({
   field: z.string(),
   oldValue: z.unknown(),
   newValue: z.unknown(),
});

export type FieldChange = z.infer<typeof FieldChangeSchema>;

/**
 * Response schema for key sync operation.
 */
export const KeySyncResponseSchema = z.object({
   creatorId: z.string(),
   changedFields: z.array(FieldChangeSchema),
   success: z.boolean(),
   timestamp: z.string(), // ISO timestamp
});

export type KeySyncResponse = z.infer<typeof KeySyncResponseSchema>;
