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
    balance: z.string(),
    updatedAt: z.date(),
});

export const HoldingItemSchema = z.object({
    id: z.string(),
    ownerAddress: z.string(),
    creatorId: z.string(),
    balance: z.string(),
    currentPrice: z.string(),
    updatedAt: z.date(),
});

export const HoldingsResponseSchema = z.object({
    holdings: z.array(HoldingItemSchema),
    total_portfolio_value: z.string(),
});

export const OwnershipResponseSchema = z.array(OwnershipItemSchema);
