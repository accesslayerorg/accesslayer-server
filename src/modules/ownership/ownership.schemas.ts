import { z } from 'zod';

export const OwnershipQuerySchema = z.object({
    ownerAddress: z.string().optional(),
    creatorId: z.string().optional(),
}).strict();

export type OwnershipQueryType = z.infer<typeof OwnershipQuerySchema>;

export const OwnershipItemSchema = z.object({
    id: z.string(),
    ownerAddress: z.string(),
    creatorId: z.string(),
    balance: z.string(), // Decimal is returned as string in Prisma Json/JsonValue but as Decimal object in real types. For API, string is safer.
    updatedAt: z.date(),
});

export const OwnershipResponseSchema = z.array(OwnershipItemSchema);
