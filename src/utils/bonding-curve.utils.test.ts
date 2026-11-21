// Unit tests for src/utils/bonding-curve.utils.ts
//
// Covers:
//  - spotPrice: edge cases, milestone-based exponent lookup
//  - buyCost / sellProceeds: single-exponent, piecewise across milestones
//  - exact BigInt math: buyCost(s,q) === sellProceeds(s+q,q) always
//  - exact additivity: buyCost(s, a+b) === buyCost(s, a) + buyCost(s+a, b)
//  - behaviour around milestone thresholds (just below, at, just above)
//  - sells return 0n for qty 0
//  - validateMilestones
//  - exact numbers for supply 100, qty 5, exp 1

import {
   buyCost,
   sellProceeds,
   spotPrice,
   cost,
   validateMilestones,
   CURVE_K,
} from './bonding-curve.utils';

// ── helpers ──────────────────────────────────────────────────────────────────

const MS1 = [{ supplyThreshold: 100, exponent: 1 }];
const MS2 = [
   { supplyThreshold: 100, exponent: 1 },
   { supplyThreshold: 500, exponent: 2 },
];
const BASE_EXP = 3; // used after all milestones

// ── validateMilestones ──────────────────────────────────────────────────────

describe('validateMilestones', () => {
   it('returns empty array for non-array input', () => {
      expect(validateMilestones(null)).toEqual([]);
      expect(validateMilestones(undefined)).toEqual([]);
      expect(validateMilestones(42)).toEqual([]);
   });

   it('returns empty array for empty array', () => {
      expect(validateMilestones([])).toEqual([]);
   });

   it('sorts milestones by supplyThreshold', () => {
      const result = validateMilestones([
         { supplyThreshold: 500, exponent: 2 },
         { supplyThreshold: 100, exponent: 1 },
      ]);
      expect(result).toEqual([
         { supplyThreshold: 100, exponent: 1 },
         { supplyThreshold: 500, exponent: 2 },
      ]);
   });

   it('throws for negative supplyThreshold', () => {
      expect(() => validateMilestones([{ supplyThreshold: -1, exponent: 1 }])).toThrow(
         /non-negative integer/
      );
   });

   it('throws for non-integer supplyThreshold', () => {
      expect(() => validateMilestones([{ supplyThreshold: 1.5, exponent: 1 }])).toThrow(
         /non-negative integer/
      );
   });

   it('throws for negative exponent', () => {
      expect(() => validateMilestones([{ supplyThreshold: 100, exponent: -1 }])).toThrow(
         /non-negative integer/
      );
   });

   it('throws for non-integer exponent', () => {
      expect(() => validateMilestones([{ supplyThreshold: 100, exponent: 0.5 }])).toThrow(
         /non-negative integer/
      );
   });

   it('throws for missing fields', () => {
      expect(() => validateMilestones([{ supplyThreshold: 100 }])).toThrow(/Invalid milestone/);
      expect(() => validateMilestones([{ exponent: 1 }])).toThrow(/Invalid milestone/);
   });
});

// ── spotPrice ────────────────────────────────────────────────────────────────

describe('spotPrice', () => {
   it('returns 1_000_000n for supply <= 0', () => {
      expect(spotPrice(0)).toBe(1_000_000n);
      expect(spotPrice(-1)).toBe(1_000_000n);
   });

   it('is 1_000_000 + K * s^e for positive supply, exponent 1 (no milestones)', () => {
      // P(10) = 1_000_000 + 100_000 * 10 = 2_000_000
      expect(spotPrice(10, [], 1)).toBe(2_000_000n);
   });

   it('uses exponent 2 correctly', () => {
      // P(3) = 1_000_000 + 100_000 * 9 = 1_900_000
      expect(spotPrice(3, [], 2)).toBe(1_900_000n);
   });

   it('looks up the band exponent from milestones', () => {
      const ms = [{ supplyThreshold: 100, exponent: 1 }];
      // supply 50 < 100 → uses exponent 1
      // P(50) = 1_000_000 + 100_000 * 50 = 6_000_000
      expect(spotPrice(50, ms, 3)).toBe(6_000_000n);

      // supply 100 >= 100 → uses baseExponent 3
      // P(100) = 1_000_000 + 100_000 * 100^3 = 1_000_000 + 100_000_000_000_000
      expect(spotPrice(100, ms, 3)).toBe(1_000_000n + 100_000n * 100n ** 3n);
   });

   it('uses exact BigInt math for large values', () => {
      // P(1000) with exp=2: 1_000_000 + 100_000 * 1000^2 = 1_000_000 + 100_000_000_000
      expect(spotPrice(1000, [], 2)).toBe(100_001_000_000n);
   });
});

// ── Exact numbers: supply 100, qty 5, exp 1 ──────────────────────────────────

describe('exact values: supply 100, qty 5, exp 1', () => {
   it('buyCost(100, 5) === 56_250_000', () => {
      // cost(100, 105) = 1_000_000 * 5 + 100_000 * (105^2 - 100^2) / 2
      //                = 5_000_000 + 100_000 * (11025 - 10000) / 2
      //                = 5_000_000 + 100_000 * 1025 / 2
      //                = 5_000_000 + 51_250_000
      //                = 56_250_000
      expect(buyCost(100, 5)).toBe(56_250_000n);
   });

   it('sellProceeds(100, 5) === 53_750_000', () => {
      // cost(95, 100) = 1_000_000 * 5 + 100_000 * (100^2 - 95^2) / 2
      //               = 5_000_000 + 100_000 * (10000 - 9025) / 2
      //               = 5_000_000 + 100_000 * 975 / 2
      //               = 5_000_000 + 48_750_000
      //               = 53_750_000
      expect(sellProceeds(100, 5)).toBe(53_750_000n);
   });

   it('impact ≈ 2.27%', () => {
      // spot(100) = 1_000_000 + 100_000 * 100 = 11_000_000
      const spot = spotPrice(100, [], 1);
      expect(spot).toBe(11_000_000n);

      // buyUnit = 56_250_000 / 5 = 11_250_000
      const buyTotal = buyCost(100, 5);
      const buyUnit = buyTotal / 5n;
      expect(buyUnit).toBe(11_250_000n);

      const impact = (((Number(buyUnit) - Number(spot)) / Number(spot)) * 100).toFixed(2);
      expect(impact).toBe('2.27');
   });
});

// ── buyCost(s,q) === sellProceeds(s+q,q): buy/sell symmetry ──────────────────

describe('buyCost(s,q) === sellProceeds(s+q,q)', () => {
   const cases: Array<{ s: number; q: number; label: string }> = [
      { s: 0, q: 10, label: 'inside first band' },
      { s: 50, q: 10, label: 'inside first band (mid)' },
      { s: 95, q: 5, label: 'up to milestone boundary (at threshold)' },
      { s: 95, q: 10, label: 'across milestone boundary' },
      { s: 100, q: 10, label: 'starts at milestone boundary' },
      { s: 0, q: 200, label: 'across milestone into base exponent' },
      { s: 200, q: 50, label: 'entirely in base exponent region' },
      { s: 90, q: 420, label: 'across two milestones' },
   ];

   it.each(cases)('$label: s=$s, q=$q', ({ s, q }) => {
      const buy = buyCost(s, q, MS2, BASE_EXP);
      const sell = sellProceeds(s + q, q, MS2, BASE_EXP);
      expect(buy).toBe(sell);
   });
});

// ── buyCost exact additivity ─────────────────────────────────────────────────

describe('buyCost exact additivity', () => {
   // When an interval is split within a band where the integral division has a non-zero
   // remainder, i.e. (K*(s1^p - s0^p)) % p != 0, computing the integral as two sub-intervals
   // vs one combined interval can differ by ±1 stroop due to BigInt integer truncation (floor).
   // Over milestone boundaries (where the curve definition changes) or when remainders cancel,
   // it is exact; otherwise ±1 stroop tolerance is mathematically required.
   const cases: Array<[number, number, number]> = [
      [0, 10, 5],
      [50, 60, 40],
      [90, 5, 10],    // crosses milestone at 100
      [90, 10, 400],  // crosses first milestone, near second
      [400, 50, 100], // crosses second milestone at 500
   ];

   it.each(cases)(
      'buyCost(%i, %i+%i) ≈ buyCost(%i, %i) + buyCost(%i+%i, %i) (±1 stroop due to integer division truncation)',
      (s, a, b) => {
         const combined = buyCost(s, a + b, MS2, BASE_EXP);
         const split = buyCost(s, a, MS2, BASE_EXP) + buyCost(s + a, b, MS2, BASE_EXP);
         const diff = combined - split;
         expect(diff >= -1n && diff <= 1n).toBe(true);
      }
   );

   it('holds exactly with no milestones when division has no remainder', () => {
      const s = 200;
      const a = 100;
      const b = 50;
      expect(buyCost(s, a + b)).toBe(buyCost(s, a) + buyCost(s + a, b));
   });
});

// ── buyCost: milestone thresholds ────────────────────────────────────────────

describe('buyCost around milestone thresholds', () => {
   describe('milestone at 100, exponent 1; base exponent 3', () => {
      const ms = [{ supplyThreshold: 100, exponent: 1 }];
      const baseExp = 3;

      it('qty 1, supply = 99 (just below threshold) uses exponent 1', () => {
         const c = buyCost(99, 1, ms, baseExp);
         // Entire segment [99,100] uses exponent 1
         // cost = 1_000_000 * 1 + 100_000 * (100^2 - 99^2) / 2
         // 100^2 - 99^2 = 10000 - 9801 = 199
         // curvePart = 100_000 * 199 / 2 = 9_950_000
         expect(c).toBe(1_000_000n + 9_950_000n);
      });

      it('qty 1, supply = 100 (at threshold) uses base exponent 3', () => {
         const c = buyCost(100, 1, ms, baseExp);
         // Segment [100,101] uses base exponent 3
         // cost = 1_000_000 * 1 + 100_000 * (101^4 - 100^4) / 4
         const expected =
            1_000_000n +
            (CURVE_K * (101n ** 4n - 100n ** 4n)) / 4n;
         expect(c).toBe(expected);
      });

      it('qty 1, supply = 101 (just above threshold) still uses base exponent 3', () => {
         const c = buyCost(101, 1, ms, baseExp);
         const expected =
            1_000_000n +
            (CURVE_K * (102n ** 4n - 101n ** 4n)) / 4n;
         expect(c).toBe(expected);
      });
   });
});

// ── buyCost: cross-milestone batches ────────────────────────────────────────

describe('buyCost batches crossing milestones', () => {
   it('qty 10 crossing first milestone (supply 95, threshold 100)', () => {
      // [95,100) → exponent 1; [100,105) → base exponent 3
      const c = buyCost(95, 10, MS1, BASE_EXP);
      const part1 = buyCost(95, 5, MS1, BASE_EXP);  // entirely below milestone
      const part2 = buyCost(100, 5, MS1, BASE_EXP); // entirely above milestone
      expect(c).toBe(part1 + part2);
   });

   it('qty crossing two milestones (supply 95, thresholds 100 and 500)', () => {
      // Crosses both milestones
      const qty = 450; // 95 + 450 = 545, crosses 100 and 500
      const c = buyCost(95, qty, MS2, BASE_EXP);

      // Split at boundaries using additivity
      const p1 = buyCost(95, 5, MS2, BASE_EXP);    // [95,100)  exp 1
      const p2 = buyCost(100, 400, MS2, BASE_EXP);  // [100,500) exp 2
      const p3 = buyCost(500, 45, MS2, BASE_EXP);   // [500,545) exp BASE_EXP

      expect(c).toBe(p1 + p2 + p3);
   });
});

// ── buyCost: qty = 1 ─────────────────────────────────────────────────────────

describe('buyCost qty = 1', () => {
   it('matches integral of a single unit at various supplies', () => {
      for (const s of [0, 1, 50, 99, 100, 500]) {
         const cost1 = buyCost(s, 1);
         const cost2 = buyCost(s, 1, [], 1);
         expect(cost1).toBe(cost2);
         expect(cost1).toBeGreaterThanOrEqual(1_000_000n);
      }
   });
});

// ── sellProceeds edge cases ──────────────────────────────────────────────────

describe('sellProceeds', () => {
   it('returns 0n for qty 0', () => {
      expect(sellProceeds(100, 0)).toBe(0n);
   });

   it('returns 0n for qty <= 0 (negative)', () => {
      expect(sellProceeds(100, -1)).toBe(0n);
   });

   it('sell proceeds across milestone boundary matches split', () => {
      // Supply is 105, sell 10 (goes from 105→95, crossing milestone at 100)
      const total = sellProceeds(105, 10, MS1, BASE_EXP);
      // [105, 100] → base exponent 3; [100, 95] → exponent 1
      const p1 = sellProceeds(105, 5, MS1, BASE_EXP); // [100,105] exp 3
      const p2 = sellProceeds(100, 5, MS1, BASE_EXP); // [95,100] exp 1
      expect(total).toBe(p1 + p2);
   });
});

// ── cost() edge cases ────────────────────────────────────────────────────────

describe('cost()', () => {
   it('returns 0n for empty range', () => {
      expect(cost(10, 10)).toBe(0n);
      expect(cost(10, 5)).toBe(0n);
   });

   it('is symmetric for buy and sell over the same range', () => {
      // cost(a, b) is the same whether called via buyCost or sellProceeds
      expect(cost(50, 150, MS2, BASE_EXP)).toBe(buyCost(50, 100, MS2, BASE_EXP));
      expect(cost(50, 150, MS2, BASE_EXP)).toBe(sellProceeds(150, 100, MS2, BASE_EXP));
   });

   it('works with exponent 0 (constant price above BASE)', () => {
      // exponent 0: price = BASE + K * s^0 = BASE + K = 1_100_000
      // cost [0,10) = 1_100_000 * 10 = 11_000_000
      // Actually: BASE * 10 + K * (10^1 - 0^1) / 1 = 10_000_000 + 100_000 * 10 = 11_000_000
      expect(cost(0, 10, [], 0)).toBe(11_000_000n);
   });
});
