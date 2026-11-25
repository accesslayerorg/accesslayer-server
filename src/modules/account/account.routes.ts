// src/modules/account/account.routes.ts
// Personal data export and account deletion endpoints (#1325). Mounted at /me.
//
// Account routes require a wallet JWT whose wallet is linked to a user account.
// The download route is authorised by its signed link alone, so the link can
// be opened without a session.

import { Router } from 'express';
import { z } from 'zod';
import { ErrorCode } from '../../constants/error.constants';
import {
   requireLinkedUser,
   linkedUserIdOf,
} from '../../middlewares/linked-user.middleware';
import {
   sendConflict,
   sendError,
   sendNotFound,
   sendSuccess,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import {
   AccountNotFoundError,
   cancelAccountDeletion,
   DeletionAlreadyRequestedError,
   DeletionBlockedError,
   DeletionGracePeriodEndedError,
   getAccountDeletion,
   NoPendingDeletionError,
   requestAccountDeletion,
} from './account-deletion.service';
import {
   DataExportInProgressError,
   DataExportNotFoundError,
   getDataExportJob,
   InvalidDownloadLinkError,
   readDataExportDownload,
   requestDataExport,
} from './data-export.service';

export const accountRouter = Router();

const linkedUserId = linkedUserIdOf;

const jobIdParamSchema = z.string().trim().min(1).max(64);
const downloadQuerySchema = z.object({
   expires: z.coerce.number().int().positive(),
   sig: z.string().min(1).max(128),
});

// ── Data export ─────────────────────────────────────────────

/** POST /me/data-export — queue an archive of the account's personal data. */
accountRouter.post('/data-export', requireLinkedUser, async (req, res, next) => {
   try {
      sendSuccess(res, await requestDataExport(linkedUserId(req)), 202);
   } catch (error) {
      if (error instanceof DataExportInProgressError) {
         sendConflict(res, error.message);
         return;
      }
      next(error);
   }
});

/** GET /me/data-export/:id — status, and a 24-hour download link once ready. */
accountRouter.get('/data-export/:id', requireLinkedUser, async (req, res, next) => {
   const jobId = jobIdParamSchema.safeParse(req.params.id);
   if (!jobId.success) {
      sendValidationError(res, 'Invalid export id');
      return;
   }
   try {
      sendSuccess(res, await getDataExportJob(linkedUserId(req), jobId.data));
   } catch (error) {
      if (error instanceof DataExportNotFoundError) {
         sendNotFound(res, 'Data export');
         return;
      }
      next(error);
   }
});

/**
 * GET /me/data-export/:id/download?expires=&sig= — the archive as a JSON file.
 * Authorised by the signed link, which expires with the export.
 */
accountRouter.get('/data-export/:id/download', async (req, res, next) => {
   const query = downloadQuerySchema.safeParse(req.query);
   if (!query.success) {
      sendValidationError(res, 'Invalid download link', zodIssuesToDetails(query.error.issues));
      return;
   }
   try {
      const archive = await readDataExportDownload(
         req.params.id,
         query.data.expires,
         query.data.sig
      );
      res.setHeader('Content-Disposition', `attachment; filename="data-export-${req.params.id}.json"`);
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json(archive);
   } catch (error) {
      if (error instanceof InvalidDownloadLinkError) {
         sendError(res, 403, ErrorCode.FORBIDDEN, error.message);
         return;
      }
      next(error);
   }
});

// ── Account deletion ────────────────────────────────────────

/**
 * POST /me/deletion — schedule deletion after the 14-day grace period. Returns
 * 409 with a detail entry per outstanding obligation while the account is
 * blocked.
 */
accountRouter.post('/deletion', requireLinkedUser, async (req, res, next) => {
   try {
      sendSuccess(res, await requestAccountDeletion(linkedUserId(req)), 201);
   } catch (error) {
      if (error instanceof DeletionBlockedError) {
         sendError(
            res,
            409,
            ErrorCode.CONFLICT,
            error.message,
            error.blockers.map(blocker => ({ field: blocker.code, message: blocker.message }))
         );
         return;
      }
      if (error instanceof DeletionAlreadyRequestedError) {
         sendConflict(res, error.message);
         return;
      }
      if (error instanceof AccountNotFoundError) {
         sendNotFound(res, 'Account');
         return;
      }
      next(error);
   }
});

/** GET /me/deletion — the latest deletion request, or null. */
accountRouter.get('/deletion', requireLinkedUser, async (req, res, next) => {
   try {
      sendSuccess(res, await getAccountDeletion(linkedUserId(req)));
   } catch (error) {
      next(error);
   }
});

/** DELETE /me/deletion — cancel a pending deletion during the grace period. */
accountRouter.delete('/deletion', requireLinkedUser, async (req, res, next) => {
   try {
      sendSuccess(res, await cancelAccountDeletion(linkedUserId(req)));
   } catch (error) {
      if (error instanceof NoPendingDeletionError) {
         sendNotFound(res, 'Pending account deletion');
         return;
      }
      if (error instanceof DeletionGracePeriodEndedError) {
         sendConflict(res, error.message);
         return;
      }
      next(error);
   }
});

export default accountRouter;
