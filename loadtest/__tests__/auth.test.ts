import {
   generateSignedWalletToken,
   getAuthHeaders,
   createWalletSession,
   base64UrlEncode,
} from '../lib/auth';
import { verifyWalletAccessToken } from '../../src/utils/jwt.utils';

describe('loadtest/lib/auth.js', () => {
   const testWallet =
      'GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR';

   it('base64UrlEncode encodes strings without padding or url unsafe characters', () => {
      const raw = 'test-string-for-base64-encoding?+/#';
      const encoded = base64UrlEncode(raw);
      expect(encoded).not.toContain('+');
      expect(encoded).not.toContain('/');
      expect(encoded).not.toContain('=');
   });

   it('generates a signed wallet token that is verifiable by the server JWT verification utility', () => {
      const token = generateSignedWalletToken(testWallet);
      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3);

      // Verify token using accesslayer-server JWT verifier
      const payload = verifyWalletAccessToken(token);
      expect(payload.wallet).toBe(testWallet);
      expect(payload.sub).toBe(testWallet);
      expect(payload.iss).toBe('accesslayer-server');
   });

   it('returns valid auth headers for k6 HTTP requests', () => {
      const headers = getAuthHeaders(testWallet);
      expect(headers).toHaveProperty('Authorization');
      expect(headers.Authorization).toMatch(/^Bearer eyJ/);
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['x-wallet-address']).toBe(testWallet);

      const token = headers.Authorization.slice(7);
      const verified = verifyWalletAccessToken(token);
      expect(verified.wallet).toBe(testWallet);
   });

   it('creates wallet session with token and headers', () => {
      const session = createWalletSession(testWallet);
      expect(session.wallet).toBe(testWallet);
      expect(typeof session.token).toBe('string');
      expect(session.headers.Authorization).toBe(`Bearer ${session.token}`);
      expect(session.headers['x-wallet-address']).toBe(testWallet);
   });
});
