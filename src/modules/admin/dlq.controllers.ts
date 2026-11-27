// Admin endpoints for the indexer dead-letter queue (#1341):
//   GET    /api/v1/admin/dlq?queue=&error=&cursor=&limit=
//   POST   /api/v1/admin/dlq/:id/replay
//   POST   /api/v1/admin/dlq/replay            { ids? | queue? | error?, limit? }
//   DELETE /api/v1/admin/dlq/:id               { reason }
// All routes sit behind adminGuard (403 for non-admin tokens).

import { NextFunction, Response } from 'express';
import { AdminRequest } from '../../middlewares/admin-guard.middleware';
import {
   sendConflict,
   sendNotFound,
   sendSuccess,
   sendUnauthorized,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import {
   deleteDlqEntry,
   DLQ_MAX_REPLAY_BATCH,
   listDlqEntries,
   replayDlqBatch,
   replayDlqEntry,
} from './dlq-admin.service';
import {
   DlqDeleteBodySchema,
   DlqIdParamsSchema,
   DlqListQuerySchema,
   DlqReplayBatchBodySchema,
} from './dlq.schemas';

function requireAdminId(req: AdminRequest, res: Response): string | null {
   if (!req.adminId) {
      sendUnauthorized(res, 'Admin identity missing from token');
      return null;
   }
   return req.adminId;
}

export async function httpListDlq(
   req: AdminRequest,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const parsed = DlqListQuerySchema.safeParse(req.query);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid query parameters',
            zodIssuesToDetails(parsed.error.issues)
         );
         return;
      }

      sendSuccess(res, await listDlqEntries(parsed.data));
   } catch (error) {
      next(error);
   }
}

export async function httpReplayDlqEntry(
   req: AdminRequest,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const params = DlqIdParamsSchema.safeParse(req.params);
      if (!params.success) {
         sendValidationError(
            res,
            'Invalid DLQ entry id',
            zodIssuesToDetails(params.error.issues)
         );
         return;
      }
      const adminId = requireAdminId(req, res);
      if (!adminId) return;

      const result = await replayDlqEntry(params.data.id, adminId);
      if (!result) {
         sendNotFound(res, 'DLQ entry');
         return;
      }
      if (result.outcome === 'ALREADY_REPLAYED') {
         sendConflict(res, 'DLQ entry has already been replayed');
         return;
      }

      sendSuccess(res, result);
   } catch (error) {
      next(error);
   }
}

export async function httpReplayDlqBatch(
   req: AdminRequest,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const body = DlqReplayBatchBodySchema.safeParse(req.body ?? {});
      if (!body.success) {
         sendValidationError(
            res,
            'Invalid request body',
            zodIssuesToDetails(body.error.issues)
         );
         return;
      }
      const adminId = requireAdminId(req, res);
      if (!adminId) return;

      const { requested, results } = await replayDlqBatch(body.data, adminId);
      sendSuccess(res, {
         requested,
         maxBatchSize: DLQ_MAX_REPLAY_BATCH,
         results,
      });
   } catch (error) {
      next(error);
   }
}

export async function httpDeleteDlqEntry(
   req: AdminRequest,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const params = DlqIdParamsSchema.safeParse(req.params);
      if (!params.success) {
         sendValidationError(
            res,
            'Invalid DLQ entry id',
            zodIssuesToDetails(params.error.issues)
         );
         return;
      }
      const body = DlqDeleteBodySchema.safeParse(req.body ?? {});
      if (!body.success) {
         sendValidationError(
            res,
            'Invalid request body',
            zodIssuesToDetails(body.error.issues)
         );
         return;
      }
      const adminId = requireAdminId(req, res);
      if (!adminId) return;

      const deleted = await deleteDlqEntry(
         params.data.id,
         body.data.reason,
         adminId
      );
      if (!deleted) {
         sendNotFound(res, 'DLQ entry');
         return;
      }

      sendSuccess(res, { id: params.data.id, deleted: true });
   } catch (error) {
      next(error);
   }
}
