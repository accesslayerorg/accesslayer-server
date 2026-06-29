import { z } from 'zod';
import { StellarAddressSchema } from '../wallet/wallet.schemas';
import { safeIntParam } from '../../utils/query.utils';
import { MIN_PAGE_SIZE, MAX_PAGE_SIZE } from '../../constants/pagination.constants';
import { PUBLIC_OFFSET_PAGINATION_DEFAULTS } from '../../utils/public-list-query-defaults';

export const WalletHoldingsParamsSchema = z.object({
    address: StellarAddressSchema,
});

export const WalletHoldingsQuerySchema = z
    .object({
        limit: safeIntParam({
            defaultValue: PUBLIC_OFFSET_PAGINATION_DEFAULTS.limit,
            min: MIN_PAGE_SIZE,
            max: MAX_PAGE_SIZE,
            label: 'Limit',
        }),
        offset: safeIntParam({
            defaultValue: PUBLIC_OFFSET_PAGINATION_DEFAULTS.offset,
            min: 0,
            max: Number.MAX_SAFE_INTEGER,
            label: 'Offset',
        }),
    })
    .strict();

export type WalletHoldingsParamsType = z.infer<typeof WalletHoldingsParamsSchema>;
export type WalletHoldingsQueryType = z.infer<typeof WalletHoldingsQuerySchema>;

export const HoldingEntrySchema = z.object({
    creator_id: z.string(),
    creator_handle: z.string().nullable(),
    key_count: z.any(),
    current_price: z.any().nullable(),
    total_value: z.any().nullable(),
});

export type HoldingEntry = z.infer<typeof HoldingEntrySchema>;
