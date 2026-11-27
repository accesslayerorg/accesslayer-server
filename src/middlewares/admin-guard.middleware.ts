import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { envConfig } from '../config';
import type { AdminJwtPayload } from '../types/auth.types';
import { sendForbidden, sendUnauthorized } from '../utils/api-response.utils';
import { logExpiredTokenRejection } from '../utils/expired-token-log.utils';

export const ADMIN_2FA_STATUS_PENDING = 'pending_2fa';
export const ADMIN_2FA_STATUS_VERIFIED = 'verified';

export interface AdminRequest extends Request {
   adminId?: string;
   adminToken?: string;
   adminClaims?: AdminJwtPayload;
   /**
    * Epoch seconds of the admin's last second-factor verification, from the
    * `mfa_at` token claim. Used to gate step-up actions (#1342).
    */
   adminMfaVerifiedAt?: number;
}

function verifyAdminRequest(
   req: AdminRequest,
   res: Response,
   next: NextFunction,
   allowPending: boolean
): void {
   const authHeader = req.headers.authorization;
   if (!authHeader?.startsWith('Bearer ')) {
      sendUnauthorized(res, 'Missing or invalid authorization header');
      return;
   }

   const token = authHeader.slice(7);
   try {
      const payload = jwt.verify(token, envConfig.JWT_SECRET) as AdminJwtPayload;
      const adminId = payload.adminId ?? payload.sub;
      if (payload.role !== 'admin' || !adminId) {
         sendForbidden(res, 'Admin authorization required');
         return;
      }

      if (
         !allowPending &&
         payload.twoFactorStatus !== undefined &&
         payload.twoFactorStatus !== ADMIN_2FA_STATUS_VERIFIED
      ) {
         sendUnauthorized(res, 'Two-factor authentication required');
         return;
      }

      req.adminId = adminId;
      req.adminToken = token;
      req.adminClaims = payload;
      if (typeof payload.mfa_at === 'number') {
         req.adminMfaVerifiedAt = payload.mfa_at;
      }
      next();
   } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
         logExpiredTokenRejection(req, token, error);
      }
      sendUnauthorized(res, 'Invalid or expired token');
   }
}

export function adminGuard(
   req: AdminRequest,
   res: Response,
   next: NextFunction
): void {
   verifyAdminRequest(req, res, next, false);
}

export function pendingAdminGuard(
   req: AdminRequest,
   res: Response,
   next: NextFunction
): void {
   verifyAdminRequest(req, res, next, true);
}
