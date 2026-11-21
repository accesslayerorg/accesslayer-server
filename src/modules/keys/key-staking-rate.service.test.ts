import {
   DEFAULT_STAKING_RATE_CONFIG,
   STAKING_RATE_CHANGE_THRESHOLD,
   computeStakingRewardRate,
   evaluateStakingRate,
   isSignificantRateChange,
   stakingRateChangeRatio,
} from './key-staking-rate.service';

const CONFIG = { baseRate: 0.1, minRate: 0.001 };

describe('computeStakingRewardRate', () => {
   it('divides the base rate by the square root of the staked supply', () => {
      expect(computeStakingRewardRate(100, CONFIG)).toBeCloseTo(0.01, 12);
      expect(computeStakingRewardRate(400, CONFIG)).toBeCloseTo(0.005, 12);
      expect(computeStakingRewardRate(2500, CONFIG)).toBeCloseTo(0.002, 12);
   });

   it('pays the base rate for an empty pool and for a single token', () => {
      expect(computeStakingRewardRate(0, CONFIG)).toBe(0.1);
      expect(computeStakingRewardRate(1, CONFIG)).toBe(0.1);
      expect(computeStakingRewardRate(0.25, CONFIG)).toBe(0.1);
   });

   it('never falls below the minimum rate', () => {
      // 0.1 / sqrt(1e8) = 0.00001, well under the 0.001 floor.
      expect(computeStakingRewardRate(1e8, CONFIG)).toBe(0.001);
      expect(computeStakingRewardRate(Number.MAX_SAFE_INTEGER, CONFIG)).toBe(0.001);
   });

   it('holds the floor exactly where the formula crosses it', () => {
      // 0.1 / sqrt(10_000) = 0.001
      expect(computeStakingRewardRate(10_000, CONFIG)).toBeCloseTo(0.001, 12);
      expect(computeStakingRewardRate(10_001, CONFIG)).toBe(0.001);
   });

   it('decreases monotonically as the staked supply grows', () => {
      let previous = Number.POSITIVE_INFINITY;
      for (const supply of [1, 4, 16, 100, 900, 5_000]) {
         const rate = computeStakingRewardRate(supply, CONFIG);
         expect(rate).toBeLessThanOrEqual(previous);
         previous = rate;
      }
   });

   it('accepts supply as a string or bigint', () => {
      expect(computeStakingRewardRate('100', CONFIG)).toBeCloseTo(0.01, 12);
      expect(computeStakingRewardRate(100n, CONFIG)).toBeCloseTo(0.01, 12);
   });

   it('uses the default config when none is given', () => {
      expect(computeStakingRewardRate(0)).toBe(DEFAULT_STAKING_RATE_CONFIG.baseRate);
   });

   it('lets the floor win when it is above the base rate', () => {
      expect(computeStakingRewardRate(100, { baseRate: 0.01, minRate: 0.05 })).toBe(0.05);
   });

   it('rejects an invalid supply', () => {
      for (const bad of [-1, NaN, Infinity, 'abc']) {
         expect(() => computeStakingRewardRate(bad, CONFIG)).toThrow(RangeError);
      }
   });

   it('rejects an invalid config', () => {
      expect(() => computeStakingRewardRate(10, { baseRate: 0, minRate: 0 })).toThrow(RangeError);
      expect(() => computeStakingRewardRate(10, { baseRate: -1, minRate: 0 })).toThrow(RangeError);
      expect(() => computeStakingRewardRate(10, { baseRate: NaN, minRate: 0 })).toThrow(RangeError);
      expect(() => computeStakingRewardRate(10, { baseRate: 0.1, minRate: -0.1 })).toThrow(RangeError);
   });
});

describe('stakingRateChangeRatio / isSignificantRateChange', () => {
   it('measures change relative to the previous rate', () => {
      expect(stakingRateChangeRatio(0.01, 0.0101)).toBeCloseTo(0.01, 10);
      expect(stakingRateChangeRatio(0.01, 0.009)).toBeCloseTo(0.1, 10);
      expect(stakingRateChangeRatio(0.01, 0.01)).toBe(0);
   });

   it('handles a zero previous rate', () => {
      expect(stakingRateChangeRatio(0, 0)).toBe(0);
      expect(stakingRateChangeRatio(0, 0.01)).toBe(Number.POSITIVE_INFINITY);
   });

   it('treats only changes above 0.5% as significant', () => {
      expect(STAKING_RATE_CHANGE_THRESHOLD).toBe(0.005);
      expect(isSignificantRateChange(1, 1.004)).toBe(false);
      expect(isSignificantRateChange(1, 1.006)).toBe(true);
      expect(isSignificantRateChange(1, 0.996)).toBe(false);
      expect(isSignificantRateChange(1, 0.99)).toBe(true);
   });

   it('does not flag a change exactly at the threshold', () => {
      expect(isSignificantRateChange(1, 1.005, 0.005)).toBe(false);
   });

   it('honours a custom threshold', () => {
      expect(isSignificantRateChange(1, 1.05, 0.1)).toBe(false);
      expect(isSignificantRateChange(1, 1.2, 0.1)).toBe(true);
   });
});

describe('evaluateStakingRate', () => {
   it('is significant on the first calculation so the opening rate is recorded', () => {
      const result = evaluateStakingRate(100, null, CONFIG);
      expect(result.rate).toBeCloseTo(0.01, 12);
      expect(result.previousRate).toBeNull();
      expect(result.changeRatio).toBeNull();
      expect(result.significant).toBe(true);
      expect(result.atMinRate).toBe(false);
   });

   it('is not significant when a small stake barely moves the rate', () => {
      const previous = computeStakingRewardRate(100_000, CONFIG);
      // sqrt(100_000) vs sqrt(100_001): well under 0.5%.
      const result = evaluateStakingRate(100_001, previous, CONFIG);
      expect(result.significant).toBe(false);
      expect(result.changeRatio).toBeLessThan(STAKING_RATE_CHANGE_THRESHOLD);
   });

   it('is significant when a large stake moves the rate', () => {
      const previous = computeStakingRewardRate(100, CONFIG); // 0.01
      const result = evaluateStakingRate(400, previous, CONFIG); // 0.005
      expect(result.rate).toBeCloseTo(0.005, 12);
      expect(result.changeRatio).toBeCloseTo(0.5, 10);
      expect(result.significant).toBe(true);
   });

   it('reports a rate increase after an unstake', () => {
      const previous = computeStakingRewardRate(400, CONFIG);
      const result = evaluateStakingRate(100, previous, CONFIG);
      expect(result.rate).toBeGreaterThan(previous);
      expect(result.significant).toBe(true);
   });

   it('reports atMinRate and no change once the floor holds the rate', () => {
      const previous = computeStakingRewardRate(1e8, CONFIG);
      const result = evaluateStakingRate(2e8, previous, CONFIG);
      expect(result.rate).toBe(0.001);
      expect(result.atMinRate).toBe(true);
      expect(result.changeRatio).toBe(0);
      expect(result.significant).toBe(false);
   });

   it('echoes the supply it computed for', () => {
      expect(evaluateStakingRate('250', null, CONFIG).totalStaked).toBe(250);
   });

   it('rejects an invalid supply', () => {
      expect(() => evaluateStakingRate(-5, null, CONFIG)).toThrow(RangeError);
   });
});
