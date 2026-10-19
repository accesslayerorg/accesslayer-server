import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { envConfig } from '../config';
import { sendForbidden, sendUnauthorized } from '../utils/api-response.utils';
import { logExpiredTokenRejection } from '../utils/expired-token-log.utils';

export interface AdminRequest extends Request {
   adminId?: string;
}

export function adminGuard(
   req: AdminRequest,
   res: Response,
   next: NextFunction
): void {
   const authHeader = req.headers.authorization;
   if (!authHeader?.startsWith('Bearer ')) {
      sendUnauthorized(res, 'Missing or invalid authorization header');
      return;
   }

   const token = authHeader.slice(7);
   try {
      const payload = jwt.verify(token, envConfig.JWT_SECRET) as {
         sub?: string;
         adminId?: string;
         role?: string;
      };
      const adminId = payload.adminId ?? payload.sub;
      if (payload.role !== 'admin' || !adminId) {
         sendForbidden(res, 'Admin authorization required');
         return;
      }
      req.adminId = adminId;
      next();
   } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
         logExpiredTokenRejection(req, token, error);
      }
      sendUnauthorized(res, 'Invalid or expired token');
   }
}
