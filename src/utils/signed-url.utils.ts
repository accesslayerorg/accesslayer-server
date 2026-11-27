// src/utils/signed-url.utils.ts
// Expiring, single-purpose capability links (#1325 data export downloads,
// #1327 attachment uploads). A link is an HMAC over `purpose`, the resource id
// and the expiry time, so it cannot be reused for another resource or purpose
// and stops working at `expiresAtMs`.

import { createHmac, timingSafeEqual } from 'crypto';
import { envConfig } from '../config';

/** Derives a per-purpose key from the server secret. */
function keyFor(purpose: string): Buffer {
   return createHmac('sha256', envConfig.JWT_SECRET)
      .update(`signed-link:${purpose}`)
      .digest();
}

/** Signature for `purpose`, `resourceId` and `expiresAtMs` (base64url). */
export function signLink(
   purpose: string,
   resourceId: string,
   expiresAtMs: number
): string {
   return createHmac('sha256', keyFor(purpose))
      .update(`${resourceId}.${expiresAtMs}`)
      .digest('base64url');
}

/**
 * Checks a link's signature and expiry. Comparison is constant-time and
 * never throws on malformed input.
 */
export function verifyLink(
   purpose: string,
   resourceId: string,
   expiresAtMs: number,
   signature: string,
   nowMs: number = Date.now()
): boolean {
   if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) return false;
   const expected = Buffer.from(signLink(purpose, resourceId, expiresAtMs));
   const given = Buffer.from(signature);
   return expected.length === given.length && timingSafeEqual(expected, given);
}
