// src/modules/lp-rewards/lp-reward-math.ts
// Exact (BigInt) arithmetic for key LP reward accrual (#1196). Nothing here
// touches the database, so every rounding rule is unit-testable.

/** Decimal places used for lp_tokens, eligible lp_tokens and entry_price. */
export const LP_TOKEN_SCALE = 7;

const BPS_DENOMINATOR = 10_000n;

export class InvalidLpAmountError extends Error {
   constructor(value: unknown) {
      super(`Invalid LP amount: ${String(value)}`);
      this.name = 'InvalidLpAmountError';
   }
}

type DecimalLike = string | number | bigint | { toFixed(dp: number): string };

function toPlainString(value: DecimalLike, scale: number): string {
   if (typeof value === 'bigint') return value.toString();
   if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new InvalidLpAmountError(value);
      return value.toFixed(scale);
   }
   if (typeof value === 'string') return value.trim();
   return value.toFixed(scale);
}

/**
 * Parses a non-negative decimal into an integer scaled by 10^scale. Rejects
 * negative values, exponents and more fractional digits than `scale`, so no
 * amount is ever silently rounded.
 */
export function parseScaled(value: DecimalLike, scale: number = LP_TOKEN_SCALE): bigint {
   const text = toPlainString(value, scale);
   const match = /^(\d+)(?:\.(\d*))?$/.exec(text);
   if (!match) throw new InvalidLpAmountError(value);
   const fraction = (match[2] ?? '').replace(/0+$/, '');
   if (fraction.length > scale) throw new InvalidLpAmountError(value);
   return BigInt(match[1]) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, '0') || '0');
}

/** Formats an integer scaled by 10^scale as a fixed-point decimal string. */
export function formatScaled(value: bigint, scale: number = LP_TOKEN_SCALE): string {
   if (scale === 0) return value.toString();
   const negative = value < 0n;
   const digits = (negative ? -value : value).toString().padStart(scale + 1, '0');
   const whole = digits.slice(0, -scale);
   const fraction = digits.slice(-scale);
   return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/** Parses an integer base-unit reward amount (Decimal(38,0) column). */
export function parseUnits(value: DecimalLike): bigint {
   return parseScaled(value, 0);
}

/**
 * Trading volume in base units: sum of price * quantity over trades, the
 * same formula key analytics uses. Rows whose price or quantity is not an
 * integer are reported back so callers can log them.
 */
export function sumTradeVolume(
   trades: Array<{ price: string; quantity: string }>
): { volume: bigint; skipped: number } {
   let volume = 0n;
   let skipped = 0;
   for (const trade of trades) {
      try {
         const price = BigInt(trade.price);
         const quantity = BigInt(trade.quantity);
         if (price < 0n || quantity < 0n) {
            skipped += 1;
            continue;
         }
         volume += price * quantity;
      } catch {
         skipped += 1;
      }
   }
   return { volume, skipped };
}

/** LP share of trading fees: floor(volume * bps / 10_000). */
export function computeLpFeeAllocation(volume: bigint, lpFeeBps: number): bigint {
   if (!Number.isInteger(lpFeeBps) || lpFeeBps < 0 || lpFeeBps > 10_000) {
      throw new RangeError(`lpFeeBps must be an integer in [0, 10000], got ${lpFeeBps}`);
   }
   if (volume <= 0n) return 0n;
   return (volume * BigInt(lpFeeBps)) / BPS_DENOMINATOR;
}

/**
 * Splits `pool` across `weights` pro-rata using the largest-remainder
 * method: each share is floor(pool * w / total), then the leftover units go
 * one each to the largest fractional remainders (ties broken by input
 * order). The result always sums to exactly `pool` when total weight > 0,
 * and every share is within one base unit of its exact pro-rata value.
 */
export function allocateProRata(pool: bigint, weights: bigint[]): bigint[] {
   if (pool < 0n) throw new RangeError('pool must be non-negative');
   if (weights.some(w => w < 0n)) throw new RangeError('weights must be non-negative');

   const total = weights.reduce((sum, w) => sum + w, 0n);
   if (pool === 0n || total === 0n) return weights.map(() => 0n);

   const shares = weights.map(w => (pool * w) / total);
   const remainders = weights.map((w, index) => ({ index, remainder: (pool * w) % total }));

   let leftover = pool - shares.reduce((sum, s) => sum + s, 0n);
   remainders.sort((a, b) =>
      a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1
   );
   for (const { index } of remainders) {
      if (leftover === 0n) break;
      if (weights[index] === 0n) continue;
      shares[index] += 1n;
      leftover -= 1n;
   }
   return shares;
}

/** value / total as a percentage with `dp` decimals (truncated). */
export function percentOf(value: bigint, total: bigint, dp = 4): string {
   if (total <= 0n || value <= 0n) return formatScaled(0n, dp);
   return formatScaled((value * 100n * 10n ** BigInt(dp)) / total, dp);
}

/**
 * Weighted-average entry price after adding `addedTokens` at `price`. All
 * inputs and the result are scaled by 10^LP_TOKEN_SCALE.
 */
export function weightedEntryPrice(
   currentTokens: bigint,
   currentEntryPrice: bigint,
   addedTokens: bigint,
   price: bigint
): bigint {
   const nextTokens = currentTokens + addedTokens;
   if (nextTokens === 0n) return price;
   return (currentTokens * currentEntryPrice + addedTokens * price) / nextTokens;
}

export function minBigInt(a: bigint, b: bigint): bigint {
   return a < b ? a : b;
}
