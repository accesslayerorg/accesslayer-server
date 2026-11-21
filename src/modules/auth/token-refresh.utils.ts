import { decodeJwt, signJwt, JwtError } from '../../utils/jwt.utils';

/** How long a freshly issued access token is valid for, in seconds (1 hour). */
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;

/**
 * The window, in seconds, before expiry during which a token is eligible
 * for refresh. A token with more than this much time remaining is not yet
 * due for refresh.
 */
export const REFRESH_WINDOW_SECONDS = 30 * 60;

export interface TokenRefreshSuccess {
   success: true;
   token: string;
   sub: string;
}

export interface TokenRefreshFailure {
   success: false;
   status: 400 | 401;
   code: 'refresh_not_due' | 'token_expired' | 'invalid_token';
}

export type TokenRefreshResult = TokenRefreshSuccess | TokenRefreshFailure;

/**
 * Issues a new access token for a valid, still-live token that is within its
 * refresh window (i.e. close to expiring but not expired yet).
 *
 * Refresh is stateless: the original token is not tracked or invalidated,
 * so it remains valid until its own expiry even after a refresh is issued.
 *
 * - Token with more than REFRESH_WINDOW_SECONDS remaining -> 400 refresh_not_due
 * - Token already past its exp -> 401 token_expired
 * - Token within the refresh window -> a new token is issued with the same `sub`
 */
export function refreshAccessToken(token: string): TokenRefreshResult {
   let payload;
   try {
      payload = decodeJwt(token);
   } catch (error) {
      if (error instanceof JwtError) {
         return { success: false, status: 401, code: 'invalid_token' };
      }
      throw error;
   }

   if (
      !payload ||
      typeof payload !== 'object' ||
      typeof payload.exp !== 'number' ||
      typeof payload.sub !== 'string'
   ) {
      return { success: false, status: 401, code: 'invalid_token' };
   }

   const nowSeconds = Math.floor(Date.now() / 1000);
   const secondsRemaining = payload.exp - nowSeconds;

   if (secondsRemaining <= 0) {
      return { success: false, status: 401, code: 'token_expired' };
   }

   if (secondsRemaining > REFRESH_WINDOW_SECONDS) {
      return { success: false, status: 400, code: 'refresh_not_due' };
   }

   const newToken = signJwt({ sub: payload.sub }, ACCESS_TOKEN_TTL_SECONDS);

   return { success: true, token: newToken, sub: payload.sub };
}
