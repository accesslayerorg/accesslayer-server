import { z } from 'zod';
import { StellarAddressSchema } from '../wallet/wallet.schemas';

export const WalletHoldingsParamsSchema = z.object({
    address: StellarAddressSchema,
});

export type WalletHoldingsParamsType = z.infer<typeof WalletHoldingsParamsSchema>;

export const HoldingEntrySchema = z.object({
    creator_id: z.string(),
    creator_handle: z.string().nullable(),
    key_count: z.any(),
    current_price: z.any().nullable(),
    total_value: z.any().nullable(),
});

export type HoldingEntry = z.infer<typeof HoldingEntrySchema>;
