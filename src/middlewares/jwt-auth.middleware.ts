// src/middlewares/jwt-auth.middleware.ts
// Express middleware for wallet-scoped JWT authentication.
//
// Tokens are issued by `utils/jwt.utils.ts` and carry the caller's Stellar
// wallet address. Two specialised guards build on `requireJwtAuth`:
//
// - `requireKeyCreator` — caller's wallet must own the creator profile that
//   maps to the `:keyId` path param (403 otherwise).
// - `requireWalletParamMatch` — caller's wallet must equal the named path
//   param (401 otherwise), used by /users/:wallet/* routes.

import { Request, Response, NextFunction } from 'express';
import { prisma } from '../utils/prisma.utils';
import {
   extractBearerToken,
   JwtVerifyError,
   verifyWalletAccessToken,
} from '../utils/jwt.utils';
import { ErrorCode, sendError } from '../utils/api-response.utils';
import { logger } from '../utils/logger.utils';

export interface AuthenticatedRequest extends Request {
   user?: {
      wallet: string;
      userId?: string;
   };
}

/**
 * Require a valid `Authorization: Bearer <token>` header. Attaches the
 * decoded wallet claim (and resolved user id when known) to `req.user`.
 */
export function requireJwtAuth(
   req: AuthenticatedRequest,
   res: Response,
   next: NextFunction
): void {
   const token = extractBearerToken(req.headers.authorization);
   if (!token) {
      sendError(
         res,
         401,
         ErrorCode.UNAUTHORIZED,
         'Authentication required. Send an Authorization: Bearer <token> header.'
      );
      return;
   }

   try {
      const payload = verifyWalletAccessToken(token);
      req.user = { wallet: payload.wallet };
      next();
   } catch (error) {
      if (error instanceof JwtVerifyError) {
         sendError(res, 401, ErrorCode.JWT_ERROR, error.message);
         return;
      }
      logger.error(
         {
            type: 'jwt_auth_unexpected_error',
            error,
            ...(req.requestId ? { requestId: req.requestId } : {}),
         },
         'Unexpected JWT verification failure'
      );
      sendError(res, 401, ErrorCode.JWT_ERROR, 'Invalid access token');
   }
}

async function resolveCreatorUserIdForKey(
   keyId: string
): Promise<string | null> {
   const creatorProfile = await prisma.creatorProfile.findFirst({
      where: { OR: [{ id: keyId }, { handle: keyId }] },
      select: { userId: true },
   });
   return creatorProfile?.userId ?? null;
}

function findFirstParam(
   value: string | string[] | undefined
): string | undefined {
   return Array.isArray(value) ? value[0] : value;
}

/**
 * Guard for creator-only analytics routes. Resolves the creator profile for
 * the `:keyId` path param and requires the JWT wallet to map to that same
 * user.
 *
 * Responses:
 * - 401 when no/invalid token or the wallet is not registered
 * - 403 when the wallet is registered but is not the key creator
 * - 404 when the key has no matching creator profile
 */
export function requireKeyCreator(paramName: string = 'keyId') {
   return async (
      req: AuthenticatedRequest,
      res: Response,
      next: NextFunction
   ): Promise<void> => {
      requireJwtAuth(req, res, async () => {
         if (!req.user) {
            return;
         }

         const keyId = findFirstParam(req.params[paramName]);
         if (!keyId) {
            sendError(
               res,
               400,
               ErrorCode.BAD_REQUEST,
               `Missing required path parameter "${paramName}".`
            );
            return;
         }

         try {
            const [creatorUserId, walletRecord] = await Promise.all([
               resolveCreatorUserIdForKey(keyId),
               prisma.stellarWallet.findUnique({
                  where: { address: req.user!.wallet },
                  select: { userId: true },
               }),
            ]);

            if (!creatorUserId) {
               sendError(res, 404, ErrorCode.NOT_FOUND, 'Key not found');
               return;
            }

            if (!walletRecord) {
               sendError(
                  res,
                  401,
                  ErrorCode.UNAUTHORIZED,
                  'Wallet address is not registered. Map your wallet to a user first.'
               );
               return;
            }

            if (walletRecord.userId !== creatorUserId) {
               sendError(
                  res,
                  403,
                  ErrorCode.FORBIDDEN,
                  'Only the key creator can access this resource.'
               );
               return;
            }

            req.user.userId = walletRecord.userId;
            next();
         } catch (error) {
            logger.error(
               {
                  type: 'require_key_creator_error',
                  keyId,
                  error,
                  ...(req.requestId ? { requestId: req.requestId } : {}),
               },
               'Failed to verify key creator access'
            );
            sendError(
               res,
               500,
               ErrorCode.INTERNAL_ERROR,
               'Failed to verify key creator access.'
            );
         }
      });
   };
}

/**
 * Guard for /users/:wallet/* routes. The JWT wallet claim must exactly match
 * the wallet in the path (case-insensitive compare; Stellar addresses are
 * encoded so this only matters for stray casing).
 *
 * Responses:
 * - 401 when no/invalid token or when the wallets do not match
 */
export function requireWalletParamMatch(paramName: string = 'wallet') {
   return (
      req: AuthenticatedRequest,
      res: Response,
      next: NextFunction
   ): void => {
      requireJwtAuth(req, res, () => {
         if (!req.user) {
            return;
         }

         const walletParam = findFirstParam(req.params[paramName]);
         if (!walletParam) {
            sendError(
               res,
               400,
               ErrorCode.BAD_REQUEST,
               `Missing required path parameter "${paramName}".`
            );
            return;
         }

         if (
            req.user!.wallet.toLowerCase() !== walletParam.trim().toLowerCase()
         ) {
            sendError(
               res,
               401,
               ErrorCode.UNAUTHORIZED,
               'Authenticated wallet does not match the requested wallet.'
            );
            return;
         }

         next();
      });
   };
}

function findFirstQueryString(value: unknown): string | undefined {
   if (Array.isArray(value)) {
      const first = value.find(item => typeof item === 'string');
      return typeof first === 'string' ? first : undefined;
   }
   return typeof value === 'string' ? value : undefined;
}

/**
 * Guard for routes that identify the wallet via a query parameter (e.g.
 * `GET /referrals/tier?wallet=`). The JWT wallet claim must exactly match the
 * named query parameter (case-insensitive).
 *
 * Responses:
 * - 400 when the wallet query parameter is missing
 * - 401 when no/invalid token or when the wallets do not match
 */
export function requireWalletQueryMatch(paramName: string = 'wallet') {
   return (
      req: AuthenticatedRequest,
      res: Response,
      next: NextFunction
   ): void => {
      requireJwtAuth(req, res, () => {
         if (!req.user) {
            return;
         }

         const walletQuery = findFirstQueryString(req.query[paramName]);
         if (!walletQuery || !walletQuery.trim()) {
            sendError(
               res,
               400,
               ErrorCode.BAD_REQUEST,
               `Missing required query parameter "${paramName}".`
            );
            return;
         }

         if (
            req.user!.wallet.toLowerCase() !== walletQuery.trim().toLowerCase()
         ) {
            sendError(
               res,
               401,
               ErrorCode.UNAUTHORIZED,
               'Authenticated wallet does not match the requested wallet.'
            );
            return;
         }

         next();
      });
   };
}
