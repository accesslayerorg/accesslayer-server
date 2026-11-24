// src/middlewares/impersonation-guard.middleware.ts
// Enforces read-only admin impersonation sessions (#1342).
//
// Mounted globally before the routers. Requests that do not carry an
// impersonation token pass through untouched. For those that do, the guard:
//   1. verifies the token signature (expiry is checked separately),
//   2. loads the session row and rejects it if ended or expired,
//   3. rejects every non-read method and every sensitive route,
//   4. marks the response with X-Impersonated-By and audits the request.
// Any failure to load the session fails closed.

import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { envConfig } from '../config';
import { extractBearerToken } from '../utils/jwt.utils';
import { prisma } from '../utils/prisma.utils';
import { ErrorCode, sendError } from '../utils/api-response.utils';
import { logger } from '../utils/logger.utils';
import { createAuditEntry } from '../modules/admin/audit-log.service';
import {
   closeExpiredImpersonation,
   readImpersonationClaim,
} from '../modules/admin/impersonation.service';

/** Header that tells clients (and the user's frontend banner) a session is active. */
export const IMPERSONATED_BY_HEADER = 'X-Impersonated-By';
export const IMPERSONATED_BY_VALUE = 'admin';

const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Route groups an impersonation session may never reach, regardless of
 * method. Matched after stripping the /api and /v<n> prefixes.
 */
const SENSITIVE_PATH_PREFIXES = [
   '/admin',
   '/auth',
   '/api-keys',
   '/export',
   '/exports',
   '/signing',
   '/webhooks',
   '/account',
];

export function isSensitiveImpersonationPath(path: string): boolean {
   const normalized = path.replace(/^\/(?:api\/)?v\d+(?=\/|$)/, '') || '/';
   return SENSITIVE_PATH_PREFIXES.some(
      prefix => normalized === prefix || normalized.startsWith(`${prefix}/`)
   );
}

/** Reason an impersonation request is denied, or null when it may proceed. */
export function impersonationDenyReason(method: string, path: string): string | null {
   if (!READ_ONLY_METHODS.has(method.toUpperCase())) {
      return 'Impersonation sessions are read-only';
   }
   if (isSensitiveImpersonationPath(path)) {
      return 'Impersonation sessions cannot access this route';
   }
   return null;
}

export async function impersonationGuard(
   req: Request,
   res: Response,
   next: NextFunction
): Promise<void> {
   const token = extractBearerToken(req.headers.authorization);
   if (!token) {
      next();
      return;
   }

   // Verify the signature but not the expiry, so an expired session can be
   // closed. A token that fails signature checks is not ours; normal auth
   // will reject it.
   let claims: jwt.JwtPayload;
   try {
      claims = jwt.verify(token, envConfig.JWT_SECRET, {
         issuer: envConfig.JWT_ISSUER,
         ignoreExpiration: true,
      }) as jwt.JwtPayload;
   } catch {
      next();
      return;
   }

   const claim = readImpersonationClaim(claims);
   if (!claim) {
      next();
      return;
   }

   try {
      const isExpired = typeof claims.exp === 'number' && claims.exp * 1000 <= Date.now();
      if (isExpired) {
         await closeExpiredImpersonation(claim.sessionId);
         next();
         return;
      }

      const session = await prisma.impersonationSession.findUnique({
         where: { id: claim.sessionId },
      });
      const isActive =
         session !== null &&
         session.endedAt === null &&
         session.expiresAt.getTime() > Date.now();

      if (!session || !isActive) {
         sendError(
            res,
            401,
            ErrorCode.UNAUTHORIZED,
            'Impersonation session has ended'
         );
         return;
      }

      const path = req.originalUrl.split('?')[0];
      const denyReason = impersonationDenyReason(req.method, req.path);

      await Promise.all([
         prisma.impersonationSession.update({
            where: { id: session.id },
            data: { requestCount: { increment: 1 } },
         }),
         createAuditEntry({
            actorWallet: session.adminId,
            actionType: 'impersonation_request',
            targetId: session.id,
            payload: {
               method: req.method,
               path,
               targetWallet: session.targetWallet,
               allowed: denyReason === null,
               ...(denyReason ? { denyReason } : {}),
            },
         }),
      ]);

      res.setHeader(IMPERSONATED_BY_HEADER, IMPERSONATED_BY_VALUE);

      if (denyReason) {
         sendError(res, 403, ErrorCode.FORBIDDEN, denyReason);
         return;
      }

      next();
   } catch (error) {
      // Fail closed: if the session cannot be verified, nothing is served.
      logger.error(
         { error, sessionId: claim.sessionId },
         'Impersonation guard failed to verify session'
      );
      sendError(res, 503, ErrorCode.INTERNAL_ERROR, 'Impersonation session could not be verified');
   }
}
