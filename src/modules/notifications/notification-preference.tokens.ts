// src/modules/notifications/notification-preference.tokens.ts
// Signed HMAC tokens for email verification and one-click unsubscribe (#1217).

import { createHmac, timingSafeEqual } from 'crypto';
import { envConfig } from '../../config';

export const TOKEN_PURPOSES = {
   VERIFY_EMAIL: 'email_verification',
   UNSUBSCRIBE: 'email_digest_unsubscribe',
} as const;

export const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export class TokenError extends Error {
   constructor(
      message: string,
      public code: 'MALFORMED_TOKEN' | 'WRONG_PURPOSE' | 'INVALID_SIGNATURE' | 'EXPIRED_TOKEN' | 'MISMATCHED_TARGET' = 'MALFORMED_TOKEN'
   ) {
      super(message);
      this.name = 'TokenError';
   }
}

function getSecret(): string {
   return envConfig.JWT_SECRET || 'accesslayer-digest-secret';
}

function deriveKey(purpose: string): Buffer {
   return createHmac('sha256', getSecret())
      .update(`token_purpose:${purpose}`)
      .digest();
}

/**
 * Creates a signed 24-hour verification token binding wallet + email + purpose.
 */
export function createVerificationToken(
   wallet: string,
   email: string,
   nowMs: number = Date.now(),
   ttlMs: number = VERIFICATION_TOKEN_TTL_MS
): string {
   const payload = {
      wallet: wallet.trim(),
      email: email.trim().toLowerCase(),
      purpose: TOKEN_PURPOSES.VERIFY_EMAIL,
      exp: nowMs + ttlMs,
   };
   const dataStr = Buffer.from(JSON.stringify(payload)).toString('base64url');
   const sig = createHmac('sha256', deriveKey(TOKEN_PURPOSES.VERIFY_EMAIL))
      .update(dataStr)
      .digest('base64url');
   return `${dataStr}.${sig}`;
}

/**
 * Verifies the verification token, checking expiry, signature, purpose, and claims.
 */
export function verifyVerificationToken(
   token: string,
   nowMs: number = Date.now()
): { wallet: string; email: string } {
   if (!token || typeof token !== 'string') {
      throw new TokenError('Missing or empty verification token', 'MALFORMED_TOKEN');
   }

   const parts = token.split('.');
   if (parts.length !== 2) {
      throw new TokenError('Malformed verification token', 'MALFORMED_TOKEN');
   }

   const [dataStr, sig] = parts;
   let payload: any;
   try {
      payload = JSON.parse(Buffer.from(dataStr, 'base64url').toString('utf8'));
   } catch {
      throw new TokenError('Malformed verification token payload', 'MALFORMED_TOKEN');
   }

   if (payload.purpose !== TOKEN_PURPOSES.VERIFY_EMAIL) {
      throw new TokenError('Token purpose mismatch: not issued for email verification', 'WRONG_PURPOSE');
   }

   const expectedSig = createHmac('sha256', deriveKey(TOKEN_PURPOSES.VERIFY_EMAIL))
      .update(dataStr)
      .digest('base64url');

   const a = Buffer.from(sig);
   const b = Buffer.from(expectedSig);
   if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new TokenError('Invalid or tampered token signature', 'INVALID_SIGNATURE');
   }

   if (!Number.isFinite(payload.exp) || payload.exp <= nowMs) {
      throw new TokenError('Verification token has expired', 'EXPIRED_TOKEN');
   }

   if (!payload.wallet || !payload.email) {
      throw new TokenError('Verification token missing required claims', 'MALFORMED_TOKEN');
   }

   return {
      wallet: payload.wallet,
      email: payload.email,
   };
}

/**
 * Creates a signed one-click unsubscribe token binding wallet + purpose.
 */
export function createUnsubscribeToken(wallet: string): string {
   const payload = {
      wallet: wallet.trim(),
      purpose: TOKEN_PURPOSES.UNSUBSCRIBE,
   };
   const dataStr = Buffer.from(JSON.stringify(payload)).toString('base64url');
   const sig = createHmac('sha256', deriveKey(TOKEN_PURPOSES.UNSUBSCRIBE))
      .update(dataStr)
      .digest('base64url');
   return `${dataStr}.${sig}`;
}

/**
 * Verifies the unsubscribe token, checking signature and purpose.
 */
export function verifyUnsubscribeToken(token: string): { wallet: string } {
   if (!token || typeof token !== 'string') {
      throw new TokenError('Missing or empty unsubscribe token', 'MALFORMED_TOKEN');
   }

   const parts = token.split('.');
   if (parts.length !== 2) {
      throw new TokenError('Malformed unsubscribe token', 'MALFORMED_TOKEN');
   }

   const [dataStr, sig] = parts;
   let payload: any;
   try {
      payload = JSON.parse(Buffer.from(dataStr, 'base64url').toString('utf8'));
   } catch {
      throw new TokenError('Malformed unsubscribe token payload', 'MALFORMED_TOKEN');
   }

   if (payload.purpose !== TOKEN_PURPOSES.UNSUBSCRIBE) {
      throw new TokenError('Token purpose mismatch: not issued for unsubscribe', 'WRONG_PURPOSE');
   }

   const expectedSig = createHmac('sha256', deriveKey(TOKEN_PURPOSES.UNSUBSCRIBE))
      .update(dataStr)
      .digest('base64url');

   const a = Buffer.from(sig);
   const b = Buffer.from(expectedSig);
   if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new TokenError('Invalid or tampered token signature', 'INVALID_SIGNATURE');
   }

   if (!payload.wallet) {
      throw new TokenError('Unsubscribe token missing wallet claim', 'MALFORMED_TOKEN');
   }

   return {
      wallet: payload.wallet,
   };
}
