jest.mock('../config', () => ({
   envConfig: { JWT_SECRET: 'x'.repeat(48) },
}));

import { signLink, verifyLink } from './signed-url.utils';

const NOW = Date.parse('2026-11-24T12:00:00Z');
const LATER = NOW + 60_000;

describe('signed links', () => {
   it('verifies a link signed for the same purpose, resource and expiry', () => {
      const sig = signLink('purpose-a', 'res-1', LATER);
      expect(verifyLink('purpose-a', 'res-1', LATER, sig, NOW)).toBe(true);
   });

   it('rejects a link reused for another resource or purpose', () => {
      const sig = signLink('purpose-a', 'res-1', LATER);
      expect(verifyLink('purpose-a', 'res-2', LATER, sig, NOW)).toBe(false);
      expect(verifyLink('purpose-b', 'res-1', LATER, sig, NOW)).toBe(false);
   });

   it('rejects a link once its expiry has passed', () => {
      const sig = signLink('purpose-a', 'res-1', LATER);
      expect(verifyLink('purpose-a', 'res-1', LATER, sig, LATER)).toBe(false);
   });

   it('rejects malformed signatures without throwing', () => {
      expect(verifyLink('purpose-a', 'res-1', LATER, '', NOW)).toBe(false);
      expect(verifyLink('purpose-a', 'res-1', Number.NaN, 'abc', NOW)).toBe(false);
   });
});
