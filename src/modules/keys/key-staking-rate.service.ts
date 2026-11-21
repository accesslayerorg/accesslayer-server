/**
 * Dynamic staking reward rate (#1191).
 *
 * The per-token reward shrinks as a key's total staked supply grows, so a pool
 * that attracts a lot of stake does not dilute rewards through inflation:
 *
 *   rate = max(min_rate, base_rate / sqrt(total_staked_supply))
 *
 * These helpers are pure. Reading the staked supply, caching the rate in
 * Redis, writing `staking_rate_snapshots` rows and emitting the change event
 * are the caller's job; this module decides what the rate is and whether it
 * moved enough to be worth recording.
 */

export interface StakingRateConfig {
   /** Rate at a total staked supply of 1. Must be a positive, finite number. */
   baseRate: number;
   /** Floor the rate never falls below. Must be a finite number >= 0. */
   minRate: number;
}

export const DEFAULT_STAKING_RATE_CONFIG: StakingRateConfig = {
   baseRate: 0.1,
   minRate: 0.001,
};

/** A rate change larger than this fraction of the previous rate is significant (0.5%). */
export const STAKING_RATE_CHANGE_THRESHOLD = 0.005;

export interface StakingRateEvaluation {
   /** Rate for the new total staked supply. */
   rate: number;
   /** Rate before this stake/unstake, or null when none was recorded. */
   previousRate: number | null;
   /** Total staked supply the rate was computed for. */
   totalStaked: number;
   /** Relative change from `previousRate`, or null when there is none. */
   changeRatio: number | null;
   /** True when the change exceeds the threshold, or there was no previous rate. */
   significant: boolean;
   /** True when the rate is held at `minRate` by the floor. */
   atMinRate: boolean;
}

function assertConfig(config: StakingRateConfig): void {
   if (!Number.isFinite(config.baseRate) || config.baseRate <= 0) {
      throw new RangeError('baseRate must be a positive, finite number');
   }
   if (!Number.isFinite(config.minRate) || config.minRate < 0) {
      throw new RangeError('minRate must be a finite number >= 0');
   }
}

function parseTotalStaked(totalStaked: number | bigint | string): number {
   const value =
      typeof totalStaked === 'number' ? totalStaked : Number(totalStaked);
   if (!Number.isFinite(value) || value < 0) {
      throw new RangeError('totalStaked must be a finite number >= 0');
   }
   return value;
}

/**
 * Reward rate for a key with `totalStaked` tokens staked.
 *
 * An empty pool (and any pool under one token, where `1 / sqrt(x)` would
 * exceed the base) earns `baseRate`. The result is never below `minRate`.
 */
export function computeStakingRewardRate(
   totalStaked: number | bigint | string,
   config: StakingRateConfig = DEFAULT_STAKING_RATE_CONFIG
): number {
   assertConfig(config);
   const supply = parseTotalStaked(totalStaked);
   const raw = supply <= 1 ? config.baseRate : config.baseRate / Math.sqrt(supply);
   return Math.max(config.minRate, raw);
}

/**
 * Relative change between two rates, as a fraction of `previousRate`
 * (0.005 = 0.5%). Returns 0 when both are 0 and Infinity when a zero rate
 * becomes non-zero.
 */
export function stakingRateChangeRatio(previousRate: number, nextRate: number): number {
   if (previousRate === nextRate) return 0;
   if (previousRate === 0) return Number.POSITIVE_INFINITY;
   return Math.abs(nextRate - previousRate) / previousRate;
}

/** True when `nextRate` differs from `previousRate` by more than `threshold`. */
export function isSignificantRateChange(
   previousRate: number,
   nextRate: number,
   threshold: number = STAKING_RATE_CHANGE_THRESHOLD
): boolean {
   return stakingRateChangeRatio(previousRate, nextRate) > threshold;
}

/**
 * Recalculate the rate after a stake or unstake and report whether it moved
 * enough to snapshot and announce.
 *
 * With no `previousRate` (the first calculation for a key) the result is
 * significant, so the opening rate is recorded in the history.
 */
export function evaluateStakingRate(
   totalStaked: number | bigint | string,
   previousRate: number | null,
   config: StakingRateConfig = DEFAULT_STAKING_RATE_CONFIG,
   threshold: number = STAKING_RATE_CHANGE_THRESHOLD
): StakingRateEvaluation {
   const supply = parseTotalStaked(totalStaked);
   const rate = computeStakingRewardRate(supply, config);
   const changeRatio =
      previousRate === null ? null : stakingRateChangeRatio(previousRate, rate);

   return {
      rate,
      previousRate,
      totalStaked: supply,
      changeRatio,
      significant: changeRatio === null || changeRatio > threshold,
      atMinRate: rate === config.minRate,
   };
}
