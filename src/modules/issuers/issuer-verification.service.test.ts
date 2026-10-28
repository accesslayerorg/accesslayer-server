import { toVerificationStatus } from './issuer-verification.service';

jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn().mockResolvedValue(null),
   cacheSetJson: jest.fn().mockResolvedValue(undefined),
   cacheInvalidate: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../utils/prisma.utils', () => ({ prisma: {} }));

const WALLET = 'GWALLET';
const NOW = new Date('2026-10-21T00:00:00.000Z');
const DAY_MS = 86_400_000;

describe('toVerificationStatus', () => {
   it('reports unverified for a wallet with no record', () => {
      expect(toVerificationStatus(WALLET, null, NOW)).toEqual({
         wallet: WALLET,
         is_verified: false,
         tier: null,
         expiry_timestamp: null,
         days_remaining: null,
      });
   });

   it('reports a non-expiring grant as verified with no day count', () => {
      const status = toVerificationStatus(
         WALLET,
         { isVerified: true, tier: 'GOLD', expiresAt: null },
         NOW
      );

      expect(status.is_verified).toBe(true);
      expect(status.tier).toBe('GOLD');
      expect(status.days_remaining).toBeNull();
   });

   it('rounds days remaining up for an active expiring grant', () => {
      const expiresAt = new Date(NOW.getTime() + 2.5 * DAY_MS);
      const status = toVerificationStatus(
         WALLET,
         { isVerified: true, tier: 'SILVER', expiresAt },
         NOW
      );

      expect(status.is_verified).toBe(true);
      expect(status.days_remaining).toBe(3);
      expect(status.expiry_timestamp).toBe(expiresAt.toISOString());
   });

   it('reports an expired grant as unverified with zero days remaining', () => {
      const expiresAt = new Date(NOW.getTime() - DAY_MS);
      const status = toVerificationStatus(
         WALLET,
         { isVerified: true, tier: 'GOLD', expiresAt },
         NOW
      );

      expect(status.is_verified).toBe(false);
      expect(status.tier).toBeNull();
      expect(status.days_remaining).toBe(0);
   });

   it('reports a revoked issuer as unverified', () => {
      const status = toVerificationStatus(
         WALLET,
         { isVerified: false, tier: null, expiresAt: null },
         NOW
      );

      expect(status.is_verified).toBe(false);
      expect(status.days_remaining).toBeNull();
   });
});
