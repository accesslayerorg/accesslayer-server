import { computeBuyCost, computeSellPayout } from './pricing.utils';

describe('computeBuyCost', () => {
   it('amount 1 at supply 0 returns base cost only', () => {
      // 10_000_000n base + 0
      const cost = computeBuyCost(0, 1, 0);
      expect(cost).toBe(10_000_000n);
   });

   it('amount 5 at supply 10 calculates correct base cost without fees', () => {
      const cost = computeBuyCost(10, 5, 0);
      // Cost of each key:
      // 10: 10_000_000 + 10_000_000 = 20_000_000
      // 11: 10_000_000 + 11_000_000 = 21_000_000
      // 12: 10_000_000 + 12_000_000 = 22_000_000
      // 13: 10_000_000 + 13_000_000 = 23_000_000
      // 14: 10_000_000 + 14_000_000 = 24_000_000
      // sum = 110_000_000n
      expect(cost).toBe(110_000_000n);
   });

   it('includes protocol fee correctly', () => {
      // fee = 100 bps (1%)
      // Cost at 0 for 1 key is 10,000,000. 1% is 100,000. Total = 10,100,000
      const cost = computeBuyCost(0, 1, 100);
      expect(cost).toBe(10_100_000n);
   });

   it('never returns a negative value for any valid input', () => {
      const cost = computeBuyCost(100, 0, 500);
      expect(cost).toBeGreaterThanOrEqual(0n);
   });
});

describe('computeSellPayout', () => {
   it('sell of 1 key at supply 10 with 5% fee returns the correct net payout', () => {
      // Gross: price of the key at supply 9 = 10_000_000 + 9_000_000 = 19_000_000
      // Fee: 5% of 19_000_000 = 950_000
      // Net: 19_000_000 - 950_000 = 18_050_000
      const payout = computeSellPayout(10, 1, 500);
      expect(payout).toBe(18_050_000n);
   });

   it('0% fee returns the full gross payout', () => {
      const payout = computeSellPayout(10, 1, 0);
      expect(payout).toBe(19_000_000n);
   });

   it('100% fee returns 0 net payout', () => {
      const payout = computeSellPayout(10, 1, 10000);
      expect(payout).toBe(0n);
   });

   it('selling the last key (supply becomes 0) returns the base price minus fee', () => {
      // Base price at supply 0 = 10_000_000. 5% fee = 500_000. Net = 9_500_000.
      const payout = computeSellPayout(1, 1, 500);
      expect(payout).toBe(9_500_000n);
   });

   it('payout is always a non-negative integer in stroops', () => {
      const normal = computeSellPayout(10, 5, 500);
      expect(normal).toBeGreaterThanOrEqual(0n);
      expect(typeof normal).toBe('bigint');

      // A fee rate above 100% would make gross - fee negative; must clamp to 0.
      const overFee = computeSellPayout(10, 1, 20000);
      expect(overFee).toBe(0n);

      const zeroAmount = computeSellPayout(10, 0, 500);
      expect(zeroAmount).toBe(0n);
   });

   it('throws when selling more keys than the current supply', () => {
      expect(() => computeSellPayout(1, 2, 500)).toThrow();
   });
});
