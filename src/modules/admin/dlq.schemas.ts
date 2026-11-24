import { z } from 'zod';
import { safeIntParam } from '../../utils/query.utils';
import { DLQ_MAX_REPLAY_BATCH } from './dlq-admin.service';

export const DLQ_DEFAULT_PAGE_SIZE = 50;
export const DLQ_MAX_PAGE_SIZE = 100;
export const DLQ_MIN_DELETE_REASON_LENGTH = 10;

const idSchema = z.string().trim().min(1, 'Id is required').max(64);
const textFilterSchema = z.string().trim().min(1).max(200);

/** GET /admin/dlq?queue=&error=&cursor=&limit= */
export const DlqListQuerySchema = z.object({
   queue: z.string().trim().min(1).max(200).optional(),
   error: textFilterSchema.optional(),
   cursor: z.string().trim().min(1).max(64).optional(),
   limit: safeIntParam({
      defaultValue: DLQ_DEFAULT_PAGE_SIZE,
      min: 1,
      max: DLQ_MAX_PAGE_SIZE,
      label: 'Limit',
   }),
});

/** Path params for /admin/dlq/:id routes. */
export const DlqIdParamsSchema = z.object({ id: idSchema });

/**
 * POST /admin/dlq/replay body. Requires ids or a queue/error filter so a
 * request cannot replay the whole queue by accident. POST /admin/dlq/:id/replay
 * takes no body.
 */
export const DlqReplayBatchBodySchema = z
   .object({
      ids: z.array(idSchema).min(1).max(DLQ_MAX_REPLAY_BATCH).optional(),
      queue: z.string().trim().min(1).max(200).optional(),
      error: textFilterSchema.optional(),
      limit: z.number().int().min(1).max(DLQ_MAX_REPLAY_BATCH).optional(),
   })
   .strict()
   .refine(body => Boolean(body.ids?.length || body.queue || body.error), {
      message: 'Provide ids or a queue/error filter',
   });

/** DELETE /admin/dlq/:id body: a reason is mandatory and is audited. */
export const DlqDeleteBodySchema = z
   .object({
      reason: z
         .string()
         .trim()
         .min(
            DLQ_MIN_DELETE_REASON_LENGTH,
            `reason must be at least ${DLQ_MIN_DELETE_REASON_LENGTH} characters`
         )
         .max(500),
   })
   .strict();
