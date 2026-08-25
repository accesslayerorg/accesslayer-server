/**
 * Token expiry validator.
 *
 * Computes the expected expiry as iat + ttlSeconds and validates that
 * the token's exp claim matches. Returns specific error codes for
 * tampered expiry or missing iat claim.
 */
export interface TokenExpiryValidationResult {
   valid: boolean;
   code?: string;
}

export function validateTokenExpiry(
   payload: { iat?: number; exp: number; ttlSeconds: number }
): TokenExpiryValidationResult {
   if (payload.iat === undefined) {
      return { valid: false, code: 'missing_iat' };
   }

   const expectedExp = payload.iat + payload.ttlSeconds;

   if (payload.exp === expectedExp) {
      return { valid: true };
   }

   if (payload.exp > expectedExp) {
      return { valid: false, code: 'token_expiry_tampered' };
   }

   if (payload.exp < expectedExp) {
      return { valid: false, code: 'token_expiry_tampered' };
   }

   return { valid: false };
}