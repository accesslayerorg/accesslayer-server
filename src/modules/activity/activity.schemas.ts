import { z } from 'zod';
import { safeIntParam } from '../../utils/query.utils';
import { PUBLIC_OFFSET_PAGINATION_DEFAULTS } from '../../utils/public-list-query-defaults';
import { MIN_PAGE_SIZE, MAX_PAGE_SIZE } from '../../constants/pagination.constants';

export const ActivityQuerySchema = z.object({
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
    creatorId: z.string().optional(),
    actor: z.string().optional(),
    type: z.enum(['CREATOR_REGISTERED', 'KEY_BOUGHT', 'KEY_SOLD', 'PROFILE_UPDATED']).optional(),
}).strict();

export type ActivityQueryType = z.infer<typeof ActivityQuerySchema>;

export const ActivityItemSchema = z.object({
    id: z.string(),
    type: z.string(),
    actor: z.string(),
    creatorId: z.string().nullable(),
    target: z.string().nullable(),
    payload: z.any(),
    createdAt: z.date(),
});

export const ActivityFeedResponseSchema = z.object({
    items: z.array(ActivityItemSchema),
    meta: z.object({
        limit: z.number(),
        offset: z.number(),
        total: z.number(),
        hasMore: z.boolean(),
    }),
});

export type ActivityFeedResponse = z.infer<typeof ActivityFeedResponseSchema>;
