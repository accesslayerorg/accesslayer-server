import { z } from 'zod';
import { StellarAddressSchema } from '../wallet/wallet.schemas';
import { safeIntParam } from '../../utils/query.utils';
import { PUBLIC_OFFSET_PAGINATION_DEFAULTS } from '../../utils/public-list-query-defaults';
import { MIN_PAGE_SIZE, MAX_PAGE_SIZE } from '../../constants/pagination.constants';

export const WalletActivityParamsSchema = z.object({
    address: StellarAddressSchema,
});

export const WalletActivityQuerySchema = z.object({
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
    type: z.enum(['buy', 'sell']).optional(),
    creator_id: z.string().optional(),
}).strict();

export type WalletActivityQueryType = z.infer<typeof WalletActivityQuerySchema>;

export const WalletActivityItemSchema = z.object({
    type: z.enum(['buy', 'sell']),
    creator_id: z.string(),
    creator_handle: z.string().nullable(),
    amount: z.any(),
    price_at_trade: z.any(),
    fee_paid: z.any(),
    ledger_sequence: z.number().nullable(),
    timestamp: z.date(),
});

export type WalletActivityItem = z.infer<typeof WalletActivityItemSchema>;
