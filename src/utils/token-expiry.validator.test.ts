import { validateTokenExpiry } from '../utils/token-expiry.validator';

describe('validateTokenExpiry', () => {
   it('accepts a token where exp === iat + ttl', () => {
      const payload = {
         iat: 1000,
         exp: 1060,
         ttlSeconds: 60,
      };

      const result = validateTokenExpiry(payload);

      expect(result.valid).toBe(true);
   });

   it('rejects a token where exp > iat + ttl with token_expiry_tampered', () => {
      const payload = {
         iat: 1000,
         exp: 1100,
         ttlSeconds: 60,
      };

      const result = validateTokenExpiry(payload);

      expect(result.valid).toBe(false);
      expect(result.code).toBe('token_expiry_tampered');
   });

   it('rejects a token where exp < iat + ttl with token_expiry_tampered', () => {
      const payload = {
         iat: 1000,
         exp: 1050,
         ttlSeconds: 60,
      };

      const result = validateTokenExpiry(payload);

      expect(result.valid).toBe(false);
      expect(result.code).toBe('token_expiry_tampered');
   });

   it('rejects a token with no iat claim with missing_iat', () => {
      const payload = {
         exp: 1100,
         ttlSeconds: 60,
      };

      const result = validateTokenExpiry(payload);

      expect(result.valid).toBe(false);
      expect(result.code).toBe('missing_iat');
   });
});