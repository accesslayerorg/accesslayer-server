// src/middlewares/moderator-guard.middleware.ts
// Wallet-scoped moderator guard for the key report queue (#1226).
//
// Moderators are identified by an operator-managed wallet allowlist
// (`MODERATOR_WALLETS`, comma-separated), mirroring how
// `QUERY_COST_ADMIN_WALLETS` grants elevated access to wallets. The caller
// must first pass `requireJwtAuth`, so the wallet is cryptographically bound
// to the bearer token.
//
// Responses:
// - 401 when no/invalid token (delegated to `requireJwtAuth`)
// - 403 when the authenticated wallet is not a moderator

import { Response, NextFunction } from 'express';
import { envConfig } from '../config';
import { sendForbidden } from '../utils/api-response.utils';
import { AuthenticatedRequest, requireJwtAuth } from './jwt-auth.middleware';

/** Parses the comma-separated allowlist into a case-insensitive set. */
export function parseModeratorWallets(raw: string | undefined): Set<string> {
   if (!raw) return new Set();
   return new Set(
      raw
         .split(',')
         .map(wallet => wallet.trim().toLowerCase())
         .filter(Boolean)
   );
}

export function isModeratorWallet(wallet: string | undefined): boolean {
   if (!wallet) return false;
   // Read per call so allowlist changes in config (and tests) take effect
   // without rebuilding the router.
   return parseModeratorWallets(envConfig.MODERATOR_WALLETS).has(
      wallet.trim().toLowerCase()
   );
}

export function requireModerator(
   req: AuthenticatedRequest,
   res: Response,
   next: NextFunction
): void {
   requireJwtAuth(req, res, () => {
      if (!isModeratorWallet(req.user?.wallet)) {
         sendForbidden(res, 'Moderator authorization required');
         return;
      }
      next();
   });
}
