// src/modules/creator-verification/creator-verification.routes.ts
// Creator verification endpoints (#1324).
//
// - creatorVerificationRouter: creator-facing, mounted at /creators ahead of the
//   general creators router so /creators/me/verification is not captured by /:id.
// - creatorVerificationAdminRouter: reviewer-facing, mounted at
//   /admin/verification and guarded by the admin JWT.

import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { ErrorCode } from '../../constants/error.constants';
import { adminGuard, AdminRequest } from '../../middlewares/admin-guard.middleware';
import { linkedUserIdOf, requireLinkedUser } from '../../middlewares/linked-user.middleware';
import {
   sendConflict,
   sendError,
   sendNotFound,
   sendPaginatedSuccess,
   sendSuccess,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import {
   ApplicationNotFoundError,
   claimVerificationApplication,
   CreatorProfileMissingError,
   decideVerificationApplication,
   getLatestVerificationApplication,
   getVerificationApplication,
   InvalidProofLinkError,
   listVerificationApplications,
   runVerificationProofCheck,
   submitVerificationApplication,
   VerificationConflictError,
} from './creator-verification.service';
import {
   MAX_PROOF_LINKS,
   MAX_PROOF_URL_LENGTH,
   PROOF_PROVIDERS,
   VERIFICATION_STATUSES,
} from './verification.constants';

export const creatorVerificationRouter = Router();
export const creatorVerificationAdminRouter = Router();

const applySchema = z.object({
   legalName: z.string().trim().min(2).max(200),
   links: z
      .array(
         z.object({
            provider: z.enum(PROOF_PROVIDERS),
            url: z.string().trim().min(1).max(MAX_PROOF_URL_LENGTH),
         })
      )
      .min(1)
      .max(MAX_PROOF_LINKS),
});

const decisionSchema = z.object({
   decision: z.enum(['approved', 'rejected']),
   note: z.string().trim().min(3).max(1000),
});

const listQuerySchema = z.object({
   page: z.coerce.number().int().min(1).max(10_000).default(1),
   limit: z.coerce.number().int().min(1).max(50).default(20),
   status: z.enum(VERIFICATION_STATUSES).optional(),
});

const idSchema = z.string().trim().min(1).max(64);

function parseId(req: Request, res: Response): string | null {
   const id = idSchema.safeParse(req.params.id);
   if (!id.success) {
      sendValidationError(res, 'Invalid application id');
      return null;
   }
   return id.data;
}

/** Maps verification errors to responses. Returns false for anything unexpected. */
function handleVerificationError(res: Response, error: unknown): boolean {
   if (error instanceof CreatorProfileMissingError || error instanceof ApplicationNotFoundError) {
      sendNotFound(res, error instanceof CreatorProfileMissingError ? 'Creator profile' : 'Verification application');
      return true;
   }
   if (error instanceof VerificationConflictError) {
      sendConflict(res, error.message);
      return true;
   }
   if (error instanceof InvalidProofLinkError) {
      sendError(res, 400, ErrorCode.VALIDATION_ERROR, error.message, [
         { field: error.field, message: error.message },
      ]);
      return true;
   }
   return false;
}

// ── Creator routes ──────────────────────────────────────────

/** POST /creators/me/verification — apply, with at least one linked account. */
creatorVerificationRouter.post('/me/verification', requireLinkedUser, async (req, res, next) => {
   const body = applySchema.safeParse(req.body);
   if (!body.success) {
      sendValidationError(res, 'Invalid application', zodIssuesToDetails(body.error.issues));
      return;
   }
   try {
      sendSuccess(
         res,
         await submitVerificationApplication(linkedUserIdOf(req), body.data),
         201
      );
   } catch (error) {
      if (!handleVerificationError(res, error)) next(error);
   }
});

/** GET /creators/me/verification — the most recent application, or null. */
creatorVerificationRouter.get('/me/verification', requireLinkedUser, async (req, res, next) => {
   try {
      sendSuccess(res, await getLatestVerificationApplication(linkedUserIdOf(req)));
   } catch (error) {
      if (!handleVerificationError(res, error)) next(error);
   }
});

// ── Reviewer routes ─────────────────────────────────────────

/** GET /admin/verification/applications — the review queue, oldest first. */
creatorVerificationAdminRouter.get('/applications', adminGuard, async (req, res, next) => {
   const query = listQuerySchema.safeParse(req.query);
   if (!query.success) {
      sendValidationError(res, 'Invalid query', zodIssuesToDetails(query.error.issues));
      return;
   }
   try {
      const { data, meta } = await listVerificationApplications(query.data);
      sendPaginatedSuccess(res, data, meta);
   } catch (error) {
      next(error);
   }
});

/** GET /admin/verification/applications/:id — application with proofs and decisions. */
creatorVerificationAdminRouter.get('/applications/:id', adminGuard, async (req, res, next) => {
   const id = parseId(req, res);
   if (!id) return;
   try {
      sendSuccess(res, await getVerificationApplication(id));
   } catch (error) {
      if (!handleVerificationError(res, error)) next(error);
   }
});

/** POST /admin/verification/applications/:id/claim — take ownership for review. */
creatorVerificationAdminRouter.post(
   '/applications/:id/claim',
   adminGuard,
   async (req, res, next) => {
      const id = parseId(req, res);
      if (!id) return;
      try {
         sendSuccess(
            res,
            await claimVerificationApplication(id, (req as AdminRequest).adminId as string)
         );
      } catch (error) {
         if (!handleVerificationError(res, error)) next(error);
      }
   }
);

/** POST /admin/verification/applications/:id/proof-check — check every linked account. */
creatorVerificationAdminRouter.post(
   '/applications/:id/proof-check',
   adminGuard,
   async (req, res, next) => {
      const id = parseId(req, res);
      if (!id) return;
      try {
         sendSuccess(res, await runVerificationProofCheck(id));
      } catch (error) {
         if (!handleVerificationError(res, error)) next(error);
      }
   }
);

/**
 * POST /admin/verification/applications/:id/decision — approve or reject a
 * claimed application. Approval needs a passing proof check.
 */
creatorVerificationAdminRouter.post(
   '/applications/:id/decision',
   adminGuard,
   async (req, res, next) => {
      const id = parseId(req, res);
      if (!id) return;
      const body = decisionSchema.safeParse(req.body);
      if (!body.success) {
         sendValidationError(res, 'Invalid decision', zodIssuesToDetails(body.error.issues));
         return;
      }
      try {
         sendSuccess(
            res,
            await decideVerificationApplication(id, (req as AdminRequest).adminId as string, body.data)
         );
      } catch (error) {
         if (!handleVerificationError(res, error)) next(error);
      }
   }
);

export default creatorVerificationRouter;
