// src/modules/reports/key-reports.routes.ts
//
// Key report endpoints (#1226):
//
//   POST  /keys/:keyId/reports     — wallet-authenticated report submission
//   GET   /admin/reports           — moderator queue (status filter, cursor)
//   PATCH /admin/reports/:id       — moderator status transition
//
// `keyReportsRouter` is mounted from keys.routes.ts via router.use('/', …);
// `adminReportsRouter` is mounted at /admin/reports in modules/index.ts.

import { Response, NextFunction, Router } from 'express';
import {
   sendConflict,
   sendError,
   sendNotFound,
   sendSuccess,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import { ErrorCode } from '../../constants/error.constants';
import {
   AuthenticatedRequest,
   requireJwtAuth,
} from '../../middlewares/jwt-auth.middleware';
import { requireModerator } from '../../middlewares/moderator-guard.middleware';
import { keyReportRateLimit } from '../../middlewares/wallet-rate-limit.middleware';
import {
   CreateKeyReportBodySchema,
   ListKeyReportsQuerySchema,
   UpdateKeyReportBodySchema,
} from './key-reports.schemas';
import {
   createKeyReport,
   DuplicateOpenKeyReportError,
   InvalidKeyReportCursorError,
   InvalidKeyReportTransitionError,
   KeyReportKeyNotFoundError,
   KeyReportNotFoundError,
   listKeyReports,
   updateKeyReportStatus,
} from './key-reports.service';

function firstParam(value: string | string[] | undefined): string {
   return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
}

/**
 * POST /keys/:keyId/reports
 * Wallet auth required. 201 with the created report (status `open`).
 */
export async function httpCreateKeyReport(
   req: AuthenticatedRequest,
   res: Response,
   next: NextFunction
): Promise<void> {
   const keyId = firstParam(req.params.keyId);
   if (!keyId) {
      sendValidationError(res, 'Missing required parameters', [
         { field: 'keyId', message: 'Key ID is required' },
      ]);
      return;
   }

   const parsed = CreateKeyReportBodySchema.safeParse(req.body ?? {});
   if (!parsed.success) {
      sendValidationError(
         res,
         'Invalid report payload',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }

   try {
      const report = await createKeyReport(
         keyId,
         req.user!.wallet,
         parsed.data
      );
      sendSuccess(res, report, 201, 'Report submitted');
   } catch (error) {
      if (error instanceof KeyReportKeyNotFoundError) {
         sendNotFound(res, 'Key');
         return;
      }
      if (error instanceof DuplicateOpenKeyReportError) {
         sendConflict(res, error.message);
         return;
      }
      next(error);
   }
}

/**
 * GET /admin/reports?status=&cursor=&limit=
 * Moderator only. Newest first; `meta.nextCursor` fetches the next page.
 */
export async function httpListKeyReports(
   req: AuthenticatedRequest,
   res: Response,
   next: NextFunction
): Promise<void> {
   const parsed = ListKeyReportsQuerySchema.safeParse(req.query);
   if (!parsed.success) {
      sendValidationError(
         res,
         'Invalid report query',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }

   try {
      sendSuccess(res, await listKeyReports(parsed.data));
   } catch (error) {
      if (error instanceof InvalidKeyReportCursorError) {
         sendValidationError(res, 'Invalid cursor', [
            { field: 'cursor', message: error.message },
         ]);
         return;
      }
      next(error);
   }
}

/**
 * PATCH /admin/reports/:id
 * Moderator only. Body: { status: 'reviewing' | 'dismissed' | 'actioned' }.
 * 409 when the transition is not allowed from the report's current status.
 */
export async function httpUpdateKeyReport(
   req: AuthenticatedRequest,
   res: Response,
   next: NextFunction
): Promise<void> {
   const reportId = firstParam(req.params.id);
   if (!reportId) {
      sendValidationError(res, 'Missing required parameters', [
         { field: 'id', message: 'Report ID is required' },
      ]);
      return;
   }

   const parsed = UpdateKeyReportBodySchema.safeParse(req.body ?? {});
   if (!parsed.success) {
      sendValidationError(
         res,
         'Invalid report update',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }

   try {
      sendSuccess(
         res,
         await updateKeyReportStatus(reportId, parsed.data.status)
      );
   } catch (error) {
      if (error instanceof KeyReportNotFoundError) {
         sendNotFound(res, 'Report');
         return;
      }
      if (error instanceof InvalidKeyReportTransitionError) {
         sendError(res, 409, ErrorCode.CONFLICT, error.message);
         return;
      }
      next(error);
   }
}

export const keyReportsRouter = Router();
keyReportsRouter.post(
   '/:keyId/reports',
   requireJwtAuth,
   keyReportRateLimit,
   httpCreateKeyReport
);

export const adminReportsRouter = Router();
adminReportsRouter.get('/', requireModerator, httpListKeyReports);
adminReportsRouter.patch('/:id', requireModerator, httpUpdateKeyReport);
