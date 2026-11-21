// src/modules/status/status.auth.ts
// Admin wallet authorization middleware for status incident creation (#1015).

import { Request, Response, NextFunction } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { envConfig } from '../../config';
import { ErrorCode, sendError } from '../../utils/api-response.utils';
import { extractBearerToken } from '../../utils/jwt.utils';
import { prisma } from '../../utils/prisma.utils';

export interface StatusAdminRequest extends Request {
   adminWallet?: string;
   adminId?: string;
}

const customAdminWallets = new Set<string>();

/** Helper to add admin wallets dynamically (useful in tests). */
export function setAdminWalletsForTesting(wallets: string[]): void {
   customAdminWallets.clear();
   for (const w of wallets) {
      customAdminWallets.add(w.trim().toLowerCase());
   }
}

export function clearAdminWalletsForTesting(): void {
   customAdminWallets.clear();
}

function getAdminWallets(): Set<string> {
   const wallets = new Set<string>(customAdminWallets);

   const sources = [
      process.env.ADMIN_WALLETS,
      envConfig.QUERY_COST_ADMIN_WALLETS,
      (envConfig as Record<string, unknown>).ADMIN_MULTISIG_WALLETS as string | undefined,
   ];

   for (const source of sources) {
      if (typeof source === 'string') {
         source
            .split(',')
            .map(w => w.trim().toLowerCase())
            .filter(Boolean)
            .forEach(w => wallets.add(w));
      }
   }

   return wallets;
}

function isValidStellarAddress(address: string): boolean {
   return typeof address === 'string' && /^G[A-Z2-7]{55}$/.test(address);
}

export async function requireStatusAdminWallet(
   req: StatusAdminRequest,
   res: Response,
   next: NextFunction
): Promise<void> {
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

   let payload: JwtPayload & {
      wallet?: string;
      role?: string;
      adminId?: string;
   };

   try {
      payload = jwt.verify(token, envConfig.JWT_SECRET) as JwtPayload;
   } catch {
      sendError(res, 401, ErrorCode.JWT_ERROR, 'Invalid or expired token');
      return;
   }

   const role = payload.role?.toLowerCase();
   const isRoleAdmin =
      role === 'admin' || role === 'system_admin';

   const wallet =
      (typeof payload.wallet === 'string' && payload.wallet.trim()) ||
      (typeof payload.sub === 'string' &&
         isValidStellarAddress(payload.sub) &&
         payload.sub.trim()) ||
      undefined;

   const adminWallets = getAdminWallets();
   const isConfiguredAdminWallet =
      Boolean(wallet && adminWallets.has(wallet.toLowerCase()));

   let isDbAdminUser = false;
   if (wallet || payload.sub) {
      try {
         const user = await (prisma as any).user?.findFirst?.({
            where: {
               OR: [
                  ...(wallet ? [{ walletAddress: wallet }] : []),
                  ...(payload.sub ? [{ id: payload.sub }] : []),
               ],
            },
            select: { isAdmin: true, role: true },
         });
         if (
            user?.isAdmin ||
            user?.role === 'ADMIN' ||
            user?.role === 'SYSTEM_ADMIN'
         ) {
            isDbAdminUser = true;
         }
      } catch {
         // Fail soft if DB is unreachable or user model is mocked
      }
   }

   if (isRoleAdmin || isConfiguredAdminWallet || isDbAdminUser) {
      req.adminWallet = wallet || payload.sub || 'admin';
      req.adminId = payload.adminId || payload.sub;
      next();
      return;
   }

   sendError(res, 403, ErrorCode.FORBIDDEN, 'Admin authorization required');
}
