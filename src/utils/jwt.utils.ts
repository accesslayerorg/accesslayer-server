// src/utils/jwt.utils.ts
// JWT issuing and verification for wallet-scoped access tokens.
//
// Access tokens carry the caller's Stellar wallet address in the `wallet`
// claim plus the standard `sub`/`iat`/`exp`/`iss` claims. Route guards verify
// the token and compare `req.user.wallet` against path parameters to enforce
// ownership (e.g. GET /users/:wallet/holdings).

import jwt, { JwtPayload, SignOptions } from 'jsonwebtoken';
import { envConfig } from '../config';

export interface WalletAccessTokenPayload extends JwtPayload {
   sub: string;
   wallet: string;
}

/** Error thrown when a token is missing, malformed, expired, or invalid. */
export class JwtVerifyError extends Error {
   constructor(message: string) {
      super(message);
      this.name = 'JwtVerifyError';
   }
}

/**
 * Sign an access token bound to a Stellar wallet address.
 *
 * @param wallet - Stellar wallet address embedded as the `wallet` claim.
 * @param subject - Optional subject (defaults to the wallet address).
 * @param expiresInSeconds - Override TTL; defaults to config.
 */
export function signWalletAccessToken(
   wallet: string,
   subject?: string,
   expiresInSeconds: number = envConfig.JWT_ACCESS_TOKEN_TTL_SECONDS
): string {
   const options: SignOptions = {
      expiresIn: expiresInSeconds,
      issuer: envConfig.JWT_ISSUER,
   };

   return jwt.sign(
      { wallet },
      envConfig.JWT_SECRET,
      { ...options, subject: subject ?? wallet }
   );
}

/**
 * Verify a bearer token and return its decoded payload.
 *
 * @throws {JwtVerifyError} when the token is missing/malformed/expired or
 *         fails signature or issuer validation.
 */
export function verifyWalletAccessToken(token: string): WalletAccessTokenPayload {
   if (!token || typeof token !== 'string') {
      throw new JwtVerifyError('Missing bearer token');
   }

   let decoded: JwtPayload | string;
   try {
      decoded = jwt.verify(token, envConfig.JWT_SECRET, {
         issuer: envConfig.JWT_ISSUER,
      });
   } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
         throw new JwtVerifyError('Access token has expired');
      }
      throw new JwtVerifyError('Invalid access token');
   }

   if (typeof decoded === 'string' || typeof decoded.wallet !== 'string' || !decoded.wallet) {
      throw new JwtVerifyError('Access token payload missing wallet claim');
   }

   return decoded as WalletAccessTokenPayload;
}

/**
 * Extract the bearer token from an `Authorization` header value
 * (`Bearer <token>`). Returns undefined when absent or malformed.
 */
export function extractBearerToken(authHeader: unknown): string | undefined {
   if (typeof authHeader !== 'string') return undefined;
   const [scheme, token] = authHeader.split(' ');
   if (!token || scheme?.toLowerCase() !== 'bearer') return undefined;
   return token.trim() || undefined;
}



export function decodeJwt(token: string): any {
   return jwt.decode(token);
}

export function signJwt(
   payload: { sub?: string; wallet?: string } | string,
   expiresInSeconds: number = envConfig.JWT_ACCESS_TOKEN_TTL_SECONDS
): string {
   if (typeof payload === "string") {
      return signWalletAccessToken(payload, undefined, expiresInSeconds);
   }
   const wallet = payload.wallet || payload.sub || "";
   return signWalletAccessToken(wallet, payload.sub, expiresInSeconds);
}

export const JwtError = JwtVerifyError;
