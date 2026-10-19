// src/utils/bonding-curve.utils.ts
//
// Pure bonding-curve math helpers — no DB, no Redis, no side-effects.
// All values are in stroops (7-decimal XLM units).
//
// Curve model:
//   Spot price at supply s: BASE_PRICE + K * s^e
//   where BASE_PRICE = 1_000_000 stroops, K = 100_000
//
// Integral (cost of buying the range [s0, s1) under exponent e):
//   BASE_PRICE * (s1 - s0) + K / (e + 1) * (s1^(e+1) - s0^(e+1))
//
// The piecewise structure (bands built from sorted milestones):
//   curveMilestones = [{ supplyThreshold, exponent }] sorted ascending.
//   Bands: [0, t1) exp e1, [t1, t2) exp e2, ..., [tn, ∞) baseExponent.
//   cost(a, b) clips [a, b) against each band and sums the integral per band.
//   buyCost(s, q) = cost(s, s+q)
//   sellProceeds(s, q) = cost(s-q, s)
//
// All arithmetic uses exact BigInt — no Math.pow, no floating-point.

/** Spot-price constant: minimum price per key in stroops (0.1 XLM). */
export const BASE_PRICE = 1_000_000n;

/** Curve steepness multiplier (K in K * s^e). */
export const CURVE_K = 100_000n;

export interface Milestone {
   supplyThreshold: number;
   exponent: number;
}

/**
 * Validate milestones from the DB.
 * - Each supplyThreshold must be an integer >= 0.
 * - Each exponent must be an integer >= 0.
 * - Must be sorted ascending by supplyThreshold (after sorting).
 *
 * Returns a sorted copy. Throws on invalid data.
 */
export function validateMilestones(raw: unknown): Milestone[] {
   if (!Array.isArray(raw)) return [];
   const result: Milestone[] = [];
   for (const item of raw) {
      if (
         typeof item !== 'object' ||
         item === null ||
         typeof (item as Record<string, unknown>).supplyThreshold !== 'number' ||
         typeof (item as Record<string, unknown>).exponent !== 'number'
      ) {
         throw new Error(
            `Invalid milestone: each must have numeric supplyThreshold and exponent`
         );
      }
      const m = item as Milestone;
      if (!Number.isInteger(m.supplyThreshold) || m.supplyThreshold < 0) {
         throw new Error(
            `Invalid milestone supplyThreshold: must be a non-negative integer, got ${m.supplyThreshold}`
         );
      }
      if (!Number.isInteger(m.exponent) || m.exponent < 0) {
         throw new Error(
            `Invalid milestone exponent: must be a non-negative integer, got ${m.exponent}`
         );
      }
      result.push({ supplyThreshold: m.supplyThreshold, exponent: m.exponent });
   }
   result.sort((a, b) => a.supplyThreshold - b.supplyThreshold);
   return result;
}

/**
 * Look up the band exponent for a given supply value.
 *
 * Bands are built from sorted milestones:
 *   [0, t1) → e1, [t1, t2) → e2, ..., [tn, ∞) → baseExponent.
 *
 * The milestone at threshold tN means "use exponent eN while supply < tN".
 * Once supply >= all thresholds, use baseExponent.
 */
function getExponentForSupply(
   supply: number,
   milestones: Milestone[],
   baseExponent: number
): number {
   for (const m of milestones) {
      if (supply < m.supplyThreshold) {
         return m.exponent;
      }
   }
   return baseExponent;
}

/**
 * Spot price at supply `s`, using the piecewise milestone-based exponent.
 * P(s) = BASE_PRICE + K * s^e  (stroops)
 *
 * Uses exact BigInt exponentiation.
 */
export function spotPrice(
   supply: number,
   milestones: Milestone[] = [],
   baseExponent: number = 1
): bigint {
   if (supply <= 0) return BASE_PRICE;
   const sorted = [...milestones].sort(
      (a, b) => a.supplyThreshold - b.supplyThreshold
   );
   const e = getExponentForSupply(supply, sorted, baseExponent);
   return BASE_PRICE + CURVE_K * BigInt(supply) ** BigInt(e);
}

/**
 * Exact BigInt integral of the bonding curve over [s0, s1) under a single
 * fixed exponent `e`.  Returns 0n when s1 <= s0.
 *
 * Cost = BASE_PRICE * (s1 - s0) + K * (s1^(e+1) - s0^(e+1)) / (e+1)
 */
function computeInterval(s0: number, s1: number, exponent: number): bigint {
   if (s1 <= s0) return 0n;
   const p = BigInt(exponent + 1);
   const basePart = BASE_PRICE * BigInt(s1 - s0);
   const curvePart =
      (CURVE_K * (BigInt(s1) ** p - BigInt(s0) ** p)) / p;
   return basePart + curvePart;
}

/**
 * Build bands from sorted milestones and baseExponent, then compute the
 * integral of the bonding curve over the half-open interval [a, b).
 *
 * Each band is { lo, hi, exponent } where [lo, hi) uses that exponent.
 * The last band covers [lastThreshold, ∞) with baseExponent.
 * We clip [a, b) against each band and sum the sub-integrals.
 */
export function cost(
   a: number,
   b: number,
   milestones: Milestone[] = [],
   baseExponent: number = 1
): bigint {
   if (b <= a) return 0n;

   const sorted = [...milestones].sort(
      (x, y) => x.supplyThreshold - y.supplyThreshold
   );

   // Build bands: [ {lo, hi, exponent}, ... ]
   // From milestones [t1/e1, t2/e2, ...] we get:
   //   [0, t1) → e1,  [t1, t2) → e2,  ...,  [tN, ∞) → baseExponent
   const bands: Array<{ lo: number; hi: number; exponent: number }> = [];
   let bandStart = 0;
   for (const m of sorted) {
      if (m.supplyThreshold > bandStart) {
         bands.push({
            lo: bandStart,
            hi: m.supplyThreshold,
            exponent: m.exponent,
         });
      }
      bandStart = m.supplyThreshold;
   }
   // Final band: [bandStart, ∞) — use a sentinel high enough
   bands.push({
      lo: bandStart,
      hi: Number.MAX_SAFE_INTEGER,
      exponent: baseExponent,
   });

   let total = 0n;
   for (const band of bands) {
      // Clip [a, b) to this band [band.lo, band.hi)
      const lo = Math.max(a, band.lo);
      const hi = Math.min(b, band.hi);
      if (lo < hi) {
         total += computeInterval(lo, hi, band.exponent);
      }
      // Once we've passed b, no more bands matter
      if (band.hi >= b) break;
   }

   return total;
}

/**
 * Total cost (in stroops) of buying `qty` keys when the current supply is
 * `supply`, using the piecewise curve defined by `milestones` and
 * `baseExponent`.
 *
 * buyCost(s, q) = cost(s, s + q)
 */
export function buyCost(
   supply: number,
   qty: number,
   milestones: Milestone[] = [],
   baseExponent: number = 1
): bigint {
   if (qty <= 0) return 0n;
   return cost(supply, supply + qty, milestones, baseExponent);
}

/**
 * Total proceeds (in stroops) from selling `qty` keys when the current supply
 * is `supply`, using the piecewise curve.
 *
 * sellProceeds(s, q) = cost(s - q, s)
 *
 * Buying and selling the same range gives identical values because both
 * delegate to the same cost() function over the same interval.
 *
 * Returns 0n when qty <= 0.  Callers are responsible for checking that
 * qty <= supply before calling this function.
 */
export function sellProceeds(
   supply: number,
   qty: number,
   milestones: Milestone[] = [],
   baseExponent: number = 1
): bigint {
   if (qty <= 0) return 0n;
   return cost(supply - qty, supply, milestones, baseExponent);
}
