// Admin endpoints for read-only impersonation (#1342):
//   POST   /api/v1/admin/impersonate   { walletAddress, reason }  -> { sessionId, token, expiresAt, ... }
//   DELETE /api/v1/admin/impersonate   { sessionId, reason? }     -> ends the session immediately
// Both sit behind adminGuard. Starting a session also requires a fresh
// second factor (see isMfaFresh).

import { NextFunction, Response } from 'express';
import { z } from 'zod';
import { AdminRequest } from '../../middlewares/admin-guard.middleware';
import {
   ErrorCode,
   sendConflict,
   sendError,
   sendNotFound,
   sendSuccess,
   sendUnauthorized,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import {
   endImpersonation,
   ImpersonationMfaRequiredError,
   ImpersonationTargetNotFoundError,
   startImpersonation,
} from './impersonation.service';

const StartImpersonationBodySchema = z
   .object({
      walletAddress: z
         .string()
         .trim()
         .regex(/^G[A-Z2-7]{55}$/, 'walletAddress must be a Stellar address'),
      reason: z
         .string()
         .trim()
         .min(10, 'reason must be at least 10 characters')
         .max(500),
   })
   .strict();

const EndImpersonationBodySchema = z
   .object({
      sessionId: z.string().trim().min(1, 'sessionId is required').max(64),
      reason: z.string().trim().max(500).optional(),
   })
   .strict();

export async function httpStartImpersonation(
   req: AdminRequest,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const body = StartImpersonationBodySchema.safeParse(req.body ?? {});
      if (!body.success) {
         sendValidationError(
            res,
            'Invalid request body',
            zodIssuesToDetails(body.error.issues)
         );
         return;
      }
      if (!req.adminId) {
         sendUnauthorized(res, 'Admin identity missing from token');
         return;
      }

      const started = await startImpersonation({
         adminId: req.adminId,
         walletAddress: body.data.walletAddress,
         reason: body.data.reason,
         adminMfaAt: req.adminMfaVerifiedAt,
      });
      sendSuccess(res, started);
   } catch (error) {
      if (error instanceof ImpersonationMfaRequiredError) {
         sendError(res, 403, ErrorCode.FORBIDDEN, error.message);
         return;
      }
      if (error instanceof ImpersonationTargetNotFoundError) {
         sendNotFound(res, 'Wallet');
         return;
      }
      next(error);
   }
}

export async function httpEndImpersonation(
   req: AdminRequest,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const body = EndImpersonationBodySchema.safeParse(req.body ?? {});
      if (!body.success) {
         sendValidationError(
            res,
            'Invalid request body',
            zodIssuesToDetails(body.error.issues)
         );
         return;
      }
      if (!req.adminId) {
         sendUnauthorized(res, 'Admin identity missing from token');
         return;
      }

      const outcome = await endImpersonation({
         sessionId: body.data.sessionId,
         adminId: req.adminId,
         reason: body.data.reason,
      });

      if (outcome === 'NOT_FOUND') {
         sendNotFound(res, 'Impersonation session');
         return;
      }
      if (outcome === 'ALREADY_ENDED') {
         sendConflict(res, 'Impersonation session has already ended');
         return;
      }

      sendSuccess(res, { sessionId: body.data.sessionId, ended: true });
   } catch (error) {
      next(error);
   }
}
