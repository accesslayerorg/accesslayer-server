import { Request } from 'express';
import jwt from 'jsonwebtoken';
import { logger } from './logger.utils';
import { getClientIp } from './client-ip.utils';

/**
 * Emits the single warn log for a request rejected because its JWT expired.
 *
 * The wallet is read from the token's (already signature-checked by
 * `jwt.verify`) claims via `jwt.decode`; the raw token string is never logged.
 */
export function logExpiredTokenRejection(
   req: Request,
   token: string,
   error: jwt.TokenExpiredError,
   now: number = Date.now()
): void {
   const claims = jwt.decode(token);
   const wallet =
      claims && typeof claims === 'object'
         ? (claims.walletAddress ?? claims.sub ?? null)
         : null;

   logger.warn(
      {
         type: 'auth_rejection',
         reason: 'expired_token',
         wallet,
         expired_at: error.expiredAt.toISOString(),
         expired_seconds_ago: Math.max(
            0,
            Math.floor((now - error.expiredAt.getTime()) / 1000)
         ),
         endpoint: req.path,
         ip_address: getClientIp(req),
      },
      'Authentication rejected: expired token'
   );
}
