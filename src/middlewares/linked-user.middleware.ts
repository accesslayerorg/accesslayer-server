// src/middlewares/linked-user.middleware.ts
// Wallet-scoped guard for routes that act on a user account (#1325, #1327).
//
// Requires a valid wallet JWT (see requireJwtAuth) whose wallet is linked to a
// user account, and exposes that account's id as `accountUserId`. A wallet
// with no linked account gets 401, since there is no account to act on.

import { NextFunction, Request, Response } from 'express';
import { ErrorCode } from '../constants/error.constants';
import { sendError } from '../utils/api-response.utils';
import { prisma } from '../utils/prisma.utils';
import { AuthenticatedRequest, requireJwtAuth } from './jwt-auth.middleware';

export interface LinkedUserRequest extends AuthenticatedRequest {
   accountUserId?: string;
}

export function requireLinkedUser(req: Request, res: Response, next: NextFunction): void {
   requireJwtAuth(req as AuthenticatedRequest, res, () => {
      const wallet = (req as LinkedUserRequest).user?.wallet;
      if (!wallet) return;

      prisma.stellarWallet
         .findUnique({ where: { address: wallet }, select: { userId: true } })
         .then(link => {
            if (!link) {
               sendError(
                  res,
                  401,
                  ErrorCode.UNAUTHORIZED,
                  'Wallet is not linked to a user account. Link your wallet first.'
               );
               return;
            }
            (req as LinkedUserRequest).accountUserId = link.userId;
            next();
         })
         .catch(next);
   });
}

/** The linked account id set by `requireLinkedUser`. Call only behind that guard. */
export function linkedUserIdOf(req: Request): string {
   return (req as LinkedUserRequest).accountUserId as string;
}
