/**
 * Linear Dutch-auction price curve.
 *
 * Amounts are handled as integer stroops (1 unit = 10^7 stroops) so the result
 * is exact and independent of floating point. The price falls linearly from
 * `startPrice` at `startLedger` to `floorPrice` at `startLedger +
 * durationLedgers` and stays at the floor afterwards:
 *
 *   elapsed  = clamp(ledger - startLedger, 0, durationLedgers)
 *   decrease = floor((startPrice - floorPrice) * elapsed / durationLedgers)
 *   price    = startPrice - decrease
 *
 * The decrease is rounded down, so the price never drops below the ideal line.
 * This is the same integer interpolation the contract is expected to use; the
 * contract is not part of this repository, so keep the vectors in
 * `dutch-auction-price.test.ts` in sync with the contract's own tests.
 */

const STROOPS_PER_UNIT = 10_000_000n;
const SCALE_DIGITS = 7;

export interface DutchAuctionPriceInput {
   startPrice: string | number | { toString(): string };
   floorPrice: string | number | { toString(): string };
   startLedger: number;
   durationLedgers: number;
}

/** Parses a non-negative decimal (up to 7 fractional digits) into stroops. */
export function toStroops(
   value: string | number | { toString(): string }
): bigint {
   const text = String(value).trim();
   const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
   if (!match) {
      throw new Error(`Invalid price amount: ${text}`);
   }
   const fraction = (match[2] ?? '').padEnd(SCALE_DIGITS, '0');
   if (/[1-9]/.test(fraction.slice(SCALE_DIGITS))) {
      throw new Error(
         `Price has more than ${SCALE_DIGITS} decimal places: ${text}`
      );
   }
   return (
      BigInt(match[1]) * STROOPS_PER_UNIT +
      BigInt(fraction.slice(0, SCALE_DIGITS))
   );
}

/** Formats stroops as a decimal string without trailing zeros. */
export function fromStroops(stroops: bigint): string {
   const whole = stroops / STROOPS_PER_UNIT;
   const fraction = (stroops % STROOPS_PER_UNIT)
      .toString()
      .padStart(SCALE_DIGITS, '0')
      .replace(/0+$/, '');
   return fraction ? `${whole}.${fraction}` : whole.toString();
}

/** Price in stroops at `ledger`. */
export function currentPriceStroops(
   auction: DutchAuctionPriceInput,
   ledger: number
): bigint {
   const start = toStroops(auction.startPrice);
   const floor = toStroops(auction.floorPrice);
   if (floor > start) {
      throw new Error('floorPrice must not exceed startPrice');
   }
   if (
      auction.durationLedgers <= 0 ||
      ledger - auction.startLedger >= auction.durationLedgers
   ) {
      return floor;
   }
   const elapsed = BigInt(Math.max(0, ledger - auction.startLedger));
   const duration = BigInt(auction.durationLedgers);
   return start - ((start - floor) * elapsed) / duration;
}

/** Price at `ledger` as a decimal string. */
export function currentPrice(
   auction: DutchAuctionPriceInput,
   ledger: number
): string {
   return fromStroops(currentPriceStroops(auction, ledger));
}

/** First ledger at which the price is at the floor. */
export function endLedger(
   auction: Pick<DutchAuctionPriceInput, 'startLedger' | 'durationLedgers'>
): number {
   return auction.startLedger + auction.durationLedgers;
}
