import type { NextFunction, Response } from 'express';
import { ErrorCode } from '../../constants/error.constants';
import type { AdminJwtPayload } from '../../types/auth.types';
import {
   sendError,
   sendSuccess,
   sendUnauthorized,
} from '../../utils/api-response.utils';
import {
   AdminTotpServiceError,
   AdminTotpLoginInput,
   loginWithAdminTotp,
   setupAdminTotp,
   verifyAdminTotpSetup,
} from './admin-2fa.service';
import type { AdminRequest } from '../../middlewares/admin-guard.middleware';

function handleTotpError(
   res: Response,
   error: unknown,
   next: NextFunction
): void {
   if (!(error instanceof AdminTotpServiceError)) {
      next(error);
      return;
   }

   if (error.retryAfterSeconds) {
      res.setHeader('Retry-After', String(error.retryAfterSeconds));
   }

   const code =
      error.statusCode === 429
         ? ErrorCode.RATE_LIMIT
         : error.statusCode === 409
           ? ErrorCode.CONFLICT
           : ErrorCode.UNAUTHORIZED;

   sendError(res, error.statusCode, code, error.message);
}

export async function httpAdminTotpSetup(
   req: AdminRequest,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      if (!req.adminId) {
         sendUnauthorized(res, 'Admin authorization required');
         return;
      }

      sendSuccess(
         res,
         await setupAdminTotp(req.adminId),
         200,
         'Two-factor setup created'
      );
   } catch (error) {
      handleTotpError(res, error, next);
   }
}

export async function httpAdminTotpVerify(
   req: AdminRequest,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      if (!req.adminId) {
         sendUnauthorized(res, 'Admin authorization required');
         return;
      }

      const { code } = req.body as { code: string };
      const enabledAt = await verifyAdminTotpSetup(req.adminId, code);
      sendSuccess(res, { enabledAt }, 200, 'Two-factor authentication enabled');
   } catch (error) {
      handleTotpError(res, error, next);
   }
}

export async function httpAdminTotpLogin(
   req: AdminRequest,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      if (!req.adminId) {
         sendUnauthorized(res, 'Admin authorization required');
         return;
      }

      const claims: AdminJwtPayload = req.adminClaims ?? {
         sub: req.adminId,
         role: 'admin',
      };
      const input = req.body as AdminTotpLoginInput;
      const result = await loginWithAdminTotp(req.adminId, claims, input);

      sendSuccess(res, result, 200, 'Two-factor authentication verified');
   } catch (error) {
      handleTotpError(res, error, next);
   }
}
