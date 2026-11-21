// src/middlewares/co-creator-permission.middleware.ts
//
// Middleware layer that validates co-creator permissions before proxying
// creator-only API requests, checking the on-chain co-creator registry
// to enforce role-based access for ADMIN, CONTENT, and REVENUE roles (#1156).

import { Request, Response, NextFunction } from 'express';
import { getCoCreatorDetail } from '../modules/co-creators/co-creators.service';
import { checkCreatorProfileOwnership } from '../utils/wallet-ownership.utils';
import { ErrorCode, sendError } from '../utils/api-response.utils';
import { logger } from '../utils/logger.utils';

export interface CoCreatorAuthenticatedRequest extends Request {
   walletAddress?: string;
   user?: {
      wallet: string;
      userId?: string;
   };
}

export type CoCreatorRole = 'ADMIN' | 'CONTENT' | 'REVENUE' | string;

/**
 * Determine required role based on explicit option or inferred from path.
 */
function inferRequiredRole(path: string): 'ADMIN' | 'CONTENT' | 'REVENUE' {
   const lower = path.toLowerCase();
   if (
      lower.includes('announcement') ||
      lower.includes('post') ||
      lower.includes('feed')
   ) {
      return 'CONTENT';
   }
   if (
      lower.includes('revenue') ||
      lower.includes('royalty') ||
      lower.includes('payout') ||
      lower.includes('dividend') ||
      lower.includes('fee')
   ) {
      return 'REVENUE';
   }
   return 'ADMIN';
}

function extractWallet(req: CoCreatorAuthenticatedRequest): string | undefined {
   if (req.walletAddress) return req.walletAddress;
   if (req.user?.wallet) return req.user.wallet;
   const header = req.headers['x-wallet-address'];
   if (Array.isArray(header)) return header[0]?.trim() || undefined;
   if (typeof header === 'string') return header.trim() || undefined;
   return undefined;
}

function extractKeyId(
   req: Request,
   paramName: string = 'keyId'
): string | undefined {
   const raw =
      req.params[paramName] ??
      req.params.keyId ??
      req.params.key_id ??
      req.params.creatorId ??
      req.params.id ??
      req.params.wallet;
   if (Array.isArray(raw)) return raw[0];
   return raw;
}

/**
 * Middleware factory that enforces co-creator role permissions.
 *
 * - Primary creator bypasses co-creator check.
 * - ADMIN role passes all creator-action endpoints.
 * - CONTENT role passes announcements endpoints only.
 * - REVENUE role passes revenue/royalties endpoints only.
 * - Returns 403 with role_required and current_role when access denied.
 */
export function requireCoCreatorPermission(
   explicitRole?: 'ADMIN' | 'CONTENT' | 'REVENUE',
   paramName: string = 'keyId'
) {
   return async (
      req: CoCreatorAuthenticatedRequest,
      res: Response,
      next: NextFunction
   ): Promise<void> => {
      try {
         const wallet = extractWallet(req);
         const keyId = extractKeyId(req, paramName);

         if (!wallet) {
            sendError(
               res,
               401,
               ErrorCode.UNAUTHORIZED,
               'Wallet address is required for co-creator permission validation.'
            );
            return;
         }

         if (!keyId) {
            sendError(
               res,
               400,
               ErrorCode.BAD_REQUEST,
               `Missing required path parameter "${paramName}" for co-creator check.`
            );
            return;
         }

         const requiredRole =
            explicitRole ??
            inferRequiredRole(req.path || req.originalUrl || '');

         // 1. Check if primary creator (bypasses co-creator check)
         try {
            const ownershipVerdict = await checkCreatorProfileOwnership(
               wallet,
               keyId
            );
            if (ownershipVerdict.status === 'granted') {
               return next();
            }
         } catch {
            // Fall through to co-creator check if ownership check errors
         }

         // 2. Fetch co-creator detail with 60s cache
         const detail = await getCoCreatorDetail(keyId, wallet);
         const currentRole = detail && detail.active ? detail.role : null;
         const upperCurrentRole = currentRole ? currentRole.toUpperCase() : null;

         // ADMIN role passes all creator-action endpoints
         if (upperCurrentRole === 'ADMIN') {
            return next();
         }

         // CONTENT role allowed on announcements only
         if (upperCurrentRole === 'CONTENT' && requiredRole === 'CONTENT') {
            return next();
         }

         // REVENUE role allowed on revenue/royalties only
         if (upperCurrentRole === 'REVENUE' && requiredRole === 'REVENUE') {
            return next();
         }

         // Access denied: return 403 with role_required and current_role
         const errorBody = {
            success: false,
            error: {
               code: ErrorCode.FORBIDDEN,
               message: `Access denied. Role "${requiredRole}" required, current role: "${currentRole ?? 'none'}".`,
               role_required: requiredRole,
               current_role: currentRole ?? null,
               details: [
                  { field: 'role_required', message: requiredRole },
                  { field: 'current_role', message: currentRole ?? 'none' },
               ],
            },
         };

         if (typeof res.setHeader === 'function') {
            res.setHeader('Content-Type', 'application/json');
         }
         res.status(403).json(errorBody);
      } catch (error) {
         logger.error(
            { error, path: req.path },
            'Co-creator permission validation failed'
         );
         sendError(
            res,
            500,
            ErrorCode.INTERNAL_ERROR,
            'Failed to validate co-creator permissions.'
         );
      }
   };
}
